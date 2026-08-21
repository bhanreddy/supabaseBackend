import crypto from 'node:crypto';
import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';
import { renderSubscriptionReceipt } from '../utils/subscriptionReceipt.js';
import {
    createPhonePeCheckout,
    getPhonePeOrderStatus,
    isPhonePeConfigured,
    validatePhonePeCallback,
} from '../services/phonePeSubscriptionService.js';

const router = express.Router();

function plain(value) {
    return JSON.parse(JSON.stringify(value || {}));
}

function paymentStatus(providerState) {
    const state = String(providerState || '').toUpperCase();
    if (['COMPLETED', 'SUCCESS', 'PAYMENT_SUCCESS'].includes(state)) return 'completed';
    if (['FAILED', 'PAYMENT_ERROR', 'DECLINED'].includes(state)) return 'failed';
    if (['EXPIRED', 'TIMED_OUT'].includes(state)) return 'expired';
    return 'pending';
}

async function persistProviderState(merchantOrderId, response) {
    const payload = plain(response);
    const status = paymentStatus(payload.state);
    return sql.begin(async (tx) => {
        const [existing] = await tx`
            SELECT * FROM saas_subscription_payments
            WHERE merchant_order_id = ${merchantOrderId}
            FOR UPDATE
        `;
        if (!existing) return null;

        // PhonePe retries callbacks. Only the first transition to completed may
        // reduce the subscription balance.
        if (existing.status === 'completed') return existing;

        const [updated] = await tx`
            UPDATE saas_subscription_payments SET
                provider_order_id = COALESCE(${payload.orderId || null}, provider_order_id),
                provider_state = ${payload.state || null},
                provider_payload = ${tx.json(payload)},
                status = ${status},
                completed_at = CASE
                    WHEN ${status} = 'completed' THEN COALESCE(completed_at, now())
                    ELSE completed_at
                END,
                updated_at = now()
            WHERE id = ${existing.id}
            RETURNING *
        `;
        if (updated && status === 'completed') {
            await tx`
                UPDATE saas_subscriptions SET
                    amount_due = GREATEST(amount_due - ${updated.amount}, 0),
                    subscription_status = 'active',
                    last_paid_at = COALESCE(last_paid_at, now()),
                    updated_at = now()
                WHERE school_id = ${updated.school_id}
            `;
        }
        return updated;
    });
}

// PhonePe cannot present a SchoolIMS JWT. Callback authenticity is established
// by the official SDK before any local payment record is changed.
router.post('/phonepe/callback', async (req, res) => {
    let callback;
    try {
        callback = validatePhonePeCallback(req.get('authorization') || '', req.body);
    } catch (error) {
        console.warn('[subscription] Rejected PhonePe callback:', error?.message || error);
        return sendError(res, 401, 'PhonePe callback validation failed');
    }

    try {
        let merchantOrderId = callback?.payload?.merchantOrderId
            || callback?.payload?.originalMerchantOrderId;
        // Some callback variants expose only PhonePe's orderId. Resolve it to
        // our merchant id from the ledger instead of confusing the two ids.
        if (!merchantOrderId && callback?.payload?.orderId) {
            const [knownPayment] = await sql`
                SELECT merchant_order_id FROM saas_subscription_payments
                WHERE provider_order_id = ${callback.payload.orderId}
            `;
            merchantOrderId = knownPayment?.merchant_order_id;
        }
        if (!merchantOrderId) {
            return sendError(res, 400, 'PhonePe callback has no merchant order id');
        }
        const payment = await persistProviderState(merchantOrderId, callback.payload);
        if (!payment) return sendError(res, 404, 'Payment was not found');
        return res.status(200).json({ received: true });
    } catch (error) {
        // A 5xx tells PhonePe the signed event was valid but not persisted, so
        // normal callback retry behaviour can recover from transient DB errors.
        console.error('[subscription] PhonePe callback persistence failed:', error?.message || error);
        return sendError(res, 500, 'PhonePe callback could not be processed');
    }
});

router.get('/phonepe/return', (_req, res) => {
    res.type('html').send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment submitted</title></head><body style="font-family:system-ui;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:90vh;margin:0"><main style="max-width:420px;text-align:center;background:white;padding:32px;border-radius:24px;box-shadow:0 18px 50px rgba(15,23,42,.12)"><div style="font-size:42px">✓</div><h1 style="font-size:22px">Payment submitted</h1><p style="color:#64748b;line-height:1.55">You can return to the NexSyrus app. We will verify the final status securely with PhonePe.</p><button onclick="window.close()" style="border:0;border-radius:12px;padding:12px 20px;background:#2563eb;color:white;font-weight:700">Return to app</button></main></body></html>');
});

router.use(requireAuth, requireRole('admin', 'principal'));

router.get('/', asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    const [subscription] = await sql`
        SELECT plan_name, billing_cycle, subscription_status, monthly_fee,
               current_period_start, current_period_end, next_due_date, amount_due,
               currency, reminder_enabled, reminder_message, last_paid_at, updated_at
        FROM saas_subscriptions
        WHERE school_id = ${schoolId}
    `;
    const receipts = await sql`
        SELECT id, document_number, financial_year, total_amount, status, issued_at, created_at
        FROM saas_subscription_receipts
        WHERE school_id = ${schoolId} AND status = 'issued'
        ORDER BY issued_at DESC NULLS LAST, created_at DESC
        LIMIT 100
    `;
    const payments = await sql`
        SELECT id, merchant_order_id, provider_order_id, amount, currency, gateway,
               status, provider_state, checkout_url, completed_at, expires_at, created_at
        FROM saas_subscription_payments
        WHERE school_id = ${schoolId}
        ORDER BY created_at DESC
        LIMIT 50
    `;
    return sendSuccess(res, schoolId, {
        subscription: subscription || null,
        receipts,
        payments,
        gateway: { provider: 'phonepe', available: isPhonePeConfigured() },
    });
}));

router.post('/payments', asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    if (!isPhonePeConfigured()) {
        return sendError(res, 503, 'PhonePe is not configured yet');
    }

    const decision = await sql.begin(async (tx) => {
        const [subscription] = await tx`
            SELECT * FROM saas_subscriptions WHERE school_id = ${schoolId} FOR UPDATE
        `;
        if (!subscription) return { error: ['No subscription is configured for this school', 404] };
        const amount = Number(subscription.amount_due);
        if (!Number.isFinite(amount) || amount <= 0) {
            return { error: ['There is no outstanding subscription payment', 409] };
        }

        await tx`
            UPDATE saas_subscription_payments SET status = 'expired', updated_at = now()
            WHERE school_id = ${schoolId} AND status = 'pending' AND expires_at <= now()
        `;
        const [active] = await tx`
            SELECT * FROM saas_subscription_payments
            WHERE school_id = ${schoolId} AND status IN ('initiated', 'pending')
            ORDER BY created_at DESC LIMIT 1
        `;
        if (active?.checkout_url && active.expires_at && new Date(active.expires_at) > new Date()) {
            return { payment: active, reused: true };
        }
        if (active?.status === 'initiated' && Date.now() - new Date(active.created_at).getTime() < 120000) {
            return { error: ['A payment is already being prepared. Please try again shortly.', 409] };
        }
        if (active) {
            await tx`
                UPDATE saas_subscription_payments
                SET status = 'failed', provider_state = 'CREATE_STALE', updated_at = now()
                WHERE id = ${active.id}
            `;
        }

        const merchantOrderId = `NEX${Date.now()}${crypto.randomBytes(6).toString('hex')}`.toUpperCase();
        const [payment] = await tx`
            INSERT INTO saas_subscription_payments
                (school_id, merchant_order_id, initiated_by, amount, currency, status)
            VALUES (${schoolId}, ${merchantOrderId}, ${req.user.internal_id || null},
                    ${amount}, ${subscription.currency || 'INR'}, 'initiated')
            RETURNING *
        `;
        return { payment, reused: false };
    });

    if (decision.error) return sendError(res, decision.error[1], decision.error[0]);
    if (decision.reused) return sendSuccess(res, schoolId, decision.payment);

    const payment = decision.payment;
    try {
        const checkout = await createPhonePeCheckout({
            merchantOrderId: payment.merchant_order_id,
            amountPaise: Math.round(Number(payment.amount) * 100),
            schoolId,
            paymentId: payment.id,
        });
        const payload = plain(checkout);
        const rawExpireAt = Number(payload.expireAt);
        const expireAtMs = Number.isFinite(rawExpireAt) && rawExpireAt > 0
            ? (rawExpireAt < 1_000_000_000_000 ? rawExpireAt * 1000 : rawExpireAt)
            : Date.now() + 20 * 60 * 1000;
        const [updated] = await sql`
            UPDATE saas_subscription_payments SET
                provider_order_id = ${payload.orderId || null},
                checkout_url = ${payload.redirectUrl || null},
                provider_state = ${payload.state || null},
                provider_payload = ${sql.json(payload)},
                status = 'pending',
                expires_at = ${new Date(expireAtMs).toISOString()},
                updated_at = now()
            WHERE id = ${payment.id}
            RETURNING *
        `;
        return sendSuccess(res, schoolId, updated, 201);
    } catch (error) {
        await sql`
            UPDATE saas_subscription_payments
            SET status = 'failed', provider_state = 'CREATE_FAILED', updated_at = now()
            WHERE id = ${payment.id}
        `;
        console.error('[subscription] PhonePe create payment:', error?.message || error);
        return sendError(res, 502, 'PhonePe could not start the payment');
    }
}));

router.get('/payments/:merchantOrderId/status', asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    const [payment] = await sql`
        SELECT * FROM saas_subscription_payments
        WHERE merchant_order_id = ${req.params.merchantOrderId} AND school_id = ${schoolId}
    `;
    if (!payment) return sendError(res, 404, 'Payment was not found');
    if (payment.status === 'completed') return sendSuccess(res, schoolId, payment);

    try {
        const provider = await getPhonePeOrderStatus(payment.merchant_order_id);
        const updated = await persistProviderState(payment.merchant_order_id, provider);
        return sendSuccess(res, schoolId, updated);
    } catch (error) {
        console.error('[subscription] PhonePe payment status:', error?.message || error);
        return sendError(res, 502, 'Could not verify the payment status');
    }
}));

router.get('/receipts/:id/download', asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
        return sendError(res, 404, 'Receipt was not found');
    }
    const [receipt] = await sql`
        SELECT * FROM saas_subscription_receipts
        WHERE id = ${req.params.id}::uuid AND school_id = ${schoolId} AND status = 'issued'
    `;
    if (!receipt) return sendError(res, 404, 'Receipt was not found');

    const filename = `${receipt.document_number.replace(/[^A-Za-z0-9_-]/g, '-')}.html`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(renderSubscriptionReceipt(receipt));
}));

// A newly provisioned cluster may briefly run newer application code before
// its database migration. Return an actionable setup response instead of an
// opaque unhandled 500; other errors continue to the global error handler.
router.use((error, _req, res, next) => {
    if (error?.code === '42P01' || error?.code === '42703') {
        console.error('[subscription] SchoolIMS billing migration is missing:', error.message);
        return sendError(
            res,
            503,
            'Subscription billing is not initialized for this cluster',
            'Apply migrations/20260817_saas_subscription_billing.sql and retry.',
        );
    }
    return next(error);
});

export default router;

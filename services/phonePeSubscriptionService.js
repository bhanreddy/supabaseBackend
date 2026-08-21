import { createRequire } from 'node:module';
import config from '../config/env.js';

const require = createRequire(import.meta.url);
const {
    Env,
    MetaInfo,
    StandardCheckoutClient,
    StandardCheckoutPayRequest,
} = require('@phonepe-pg/pg-sdk-node');

let client;

export function isPhonePeConfigured() {
    const p = config.phonePe;
    return Boolean(p.clientId && p.clientSecret && p.redirectUrl);
}

function getClient() {
    if (!isPhonePeConfigured()) {
        const error = new Error('PhonePe is not configured yet');
        error.code = 'PHONEPE_NOT_CONFIGURED';
        error.status = 503;
        throw error;
    }
    if (!client) {
        client = StandardCheckoutClient.getInstance(
            config.phonePe.clientId,
            config.phonePe.clientSecret,
            config.phonePe.clientVersion,
            config.phonePe.environment === 'PRODUCTION' ? Env.PRODUCTION : Env.SANDBOX,
        );
    }
    return client;
}

export async function createPhonePeCheckout({ merchantOrderId, amountPaise, schoolId, paymentId }) {
    const metaInfo = MetaInfo.builder()
        .udf1(String(paymentId).slice(0, 256))
        .udf2(String(schoolId).slice(0, 256))
        .udf3('NexSyrus subscription')
        .build();
    const request = StandardCheckoutPayRequest.builder()
        .merchantOrderId(merchantOrderId)
        .amount(amountPaise)
        .redirectUrl(config.phonePe.redirectUrl)
        .message('NexSyrus subscription payment')
        .metaInfo(metaInfo)
        .expireAfter(1200)
        .build();
    return getClient().pay(request);
}

export function getPhonePeOrderStatus(merchantOrderId) {
    return getClient().getOrderStatus(merchantOrderId, true);
}

export function validatePhonePeCallback(authorization, body) {
    if (!config.phonePe.callbackUsername || !config.phonePe.callbackPassword) {
        const error = new Error('PhonePe callback credentials are not configured');
        error.code = 'PHONEPE_CALLBACK_NOT_CONFIGURED';
        error.status = 503;
        throw error;
    }
    return getClient().validateCallback(
        config.phonePe.callbackUsername,
        config.phonePe.callbackPassword,
        authorization,
        typeof body === 'string' ? body : JSON.stringify(body),
    );
}

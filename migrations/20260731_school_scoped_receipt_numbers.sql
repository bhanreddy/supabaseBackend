-- Give every school an independent, transaction-safe receipt number series.
--
-- The old implementation used public.receipt_no_seq for every tenant, so a
-- receipt issued by one school consumed the next number for all other schools.
-- Counter rows are updated inside the same transaction as the receipt insert;
-- a failed/rolled-back receipt therefore does not permanently burn a number.

BEGIN;

CREATE TABLE IF NOT EXISTS public.receipt_number_counters (
    school_id INTEGER PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
    last_number BIGINT NOT NULL CHECK (last_number >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The counter is internal database state. Callers obtain numbers through the
-- function below; no tenant should read or update another school's counter.
ALTER TABLE public.receipt_number_counters ENABLE ROW LEVEL SECURITY;

-- Continue each school from its own highest existing numeric suffix. This does
-- not renumber historical receipts, which must remain immutable.
INSERT INTO public.receipt_number_counters (school_id, last_number)
SELECT
    school_id,
    GREATEST(1000::BIGINT, MAX(SUBSTRING(receipt_no FROM '([0-9]+)$')::BIGINT))
FROM public.receipts
WHERE receipt_no ~ '[0-9]+$'
GROUP BY school_id
ON CONFLICT (school_id) DO UPDATE
SET last_number = GREATEST(
        public.receipt_number_counters.last_number,
        EXCLUDED.last_number
    ),
    updated_at = NOW();

CREATE OR REPLACE FUNCTION public.get_next_receipt_no(p_school_id INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_next_number BIGINT;
BEGIN
    IF p_school_id IS NULL THEN
        RAISE EXCEPTION 'school_id is required to generate a receipt number';
    END IF;

    INSERT INTO public.receipt_number_counters AS counters (
        school_id,
        last_number,
        updated_at
    )
    VALUES (
        p_school_id,
        GREATEST(
            1001::BIGINT,
            COALESCE((
                SELECT MAX(SUBSTRING(r.receipt_no FROM '([0-9]+)$')::BIGINT) + 1
                FROM public.receipts r
                WHERE r.school_id = p_school_id
                  AND r.receipt_no ~ '[0-9]+$'
            ), 1001::BIGINT)
        ),
        NOW()
    )
    ON CONFLICT (school_id) DO UPDATE
    SET last_number = counters.last_number + 1,
        updated_at = NOW()
    RETURNING last_number INTO v_next_number;

    RETURN 'RCT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-'
        || LPAD(v_next_number::TEXT, 4, '0');
END;
$$;

-- Repoint the fee-transaction trigger, including the combined-receipt path.
CREATE OR REPLACE FUNCTION public.auto_generate_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_receipt_id UUID;
    v_student_id UUID;
    v_receipt_no TEXT;
BEGIN
    SELECT student_id INTO v_student_id
    FROM public.student_fees
    WHERE id = NEW.student_fee_id;

    IF NEW.receipt_group IS NOT NULL THEN
        SELECT id INTO v_receipt_id
        FROM public.receipts
        WHERE school_id = NEW.school_id
          AND receipt_group = NEW.receipt_group;

        IF v_receipt_id IS NULL THEN
            v_receipt_no := public.get_next_receipt_no(NEW.school_id);

            INSERT INTO public.receipts (
                school_id,
                receipt_no,
                student_id,
                total_amount,
                issued_at,
                issued_by,
                remarks,
                receipt_group
            )
            VALUES (
                NEW.school_id,
                v_receipt_no,
                v_student_id,
                NEW.amount,
                NEW.paid_at,
                NEW.received_by,
                COALESCE(NEW.remarks, 'System Generated'),
                NEW.receipt_group
            )
            RETURNING id INTO v_receipt_id;
        ELSE
            UPDATE public.receipts
            SET total_amount = total_amount + NEW.amount
            WHERE id = v_receipt_id;
        END IF;

        INSERT INTO public.receipt_items (
            school_id,
            receipt_id,
            fee_transaction_id,
            amount
        )
        VALUES (NEW.school_id, v_receipt_id, NEW.id, NEW.amount);

        RETURN NEW;
    END IF;

    v_receipt_no := public.get_next_receipt_no(NEW.school_id);

    INSERT INTO public.receipts (
        school_id,
        receipt_no,
        student_id,
        total_amount,
        issued_at,
        issued_by,
        remarks
    )
    VALUES (
        NEW.school_id,
        v_receipt_no,
        v_student_id,
        NEW.amount,
        NEW.paid_at,
        NEW.received_by,
        COALESCE(NEW.remarks, 'System Generated')
    )
    RETURNING id INTO v_receipt_id;

    INSERT INTO public.receipt_items (
        school_id,
        receipt_id,
        fee_transaction_id,
        amount
    )
    VALUES (NEW.school_id, v_receipt_id, NEW.id, NEW.amount);

    RETURN NEW;
END;
$$;

COMMENT ON TABLE public.receipt_number_counters IS
    'Transaction-safe last issued receipt number, independently maintained per school.';

COMMENT ON FUNCTION public.get_next_receipt_no(INTEGER) IS
    'Returns the next receipt number from the requesting school''s independent series.';

COMMIT;

-- Combined multi-fee-type collection: pay several fee types in one go and
-- produce a SINGLE receipt (one receipt_no, multiple line items) instead of one
-- receipt per fee type.
--
-- Design: per-fee ledger accuracy still requires one fee_transactions row per
-- fee type (the update_fee_paid_amount trigger deducts each fee's balance). To
-- collapse those into one receipt we tag the sibling transactions with a shared
-- receipt_group UUID; auto_generate_receipt() then rolls them into one receipt.
--
-- Backward compatible: existing single-collect inserts leave receipt_group NULL
-- and take the unchanged one-receipt-per-transaction path.

ALTER TABLE fee_transactions ADD COLUMN IF NOT EXISTS receipt_group UUID;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS receipt_group UUID;

-- One receipt per group per school (lets the trigger find & append to it).
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_group_unique
  ON receipts (school_id, receipt_group)
  WHERE receipt_group IS NOT NULL;

-- Group-aware auto-receipt. NULL receipt_group => original behaviour verbatim.
CREATE OR REPLACE FUNCTION auto_generate_receipt()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_receipt_id UUID;
    v_student_id UUID;
    v_receipt_no TEXT;
BEGIN
    SELECT student_id INTO v_student_id FROM student_fees WHERE id = NEW.student_fee_id;

    -- Combined collection: all transactions sharing NEW.receipt_group roll into
    -- a single receipt. First sibling creates the receipt; the rest append an
    -- item and grow the total.
    IF NEW.receipt_group IS NOT NULL THEN
        SELECT id INTO v_receipt_id
        FROM receipts
        WHERE school_id = NEW.school_id
          AND receipt_group = NEW.receipt_group;

        IF v_receipt_id IS NULL THEN
            v_receipt_no := 'RCT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(NEXTVAL('receipt_no_seq')::TEXT, 4, '0');
            INSERT INTO receipts (school_id, receipt_no, student_id, total_amount, issued_at, issued_by, remarks, receipt_group)
            VALUES (NEW.school_id, v_receipt_no, v_student_id, NEW.amount, NEW.paid_at, NEW.received_by, COALESCE(NEW.remarks, 'System Generated'), NEW.receipt_group)
            RETURNING id INTO v_receipt_id;
        ELSE
            UPDATE receipts
            SET total_amount = total_amount + NEW.amount
            WHERE id = v_receipt_id;
        END IF;

        INSERT INTO receipt_items (school_id, receipt_id, fee_transaction_id, amount)
        VALUES (NEW.school_id, v_receipt_id, NEW.id, NEW.amount);

        RETURN NEW;
    END IF;

    -- Default (unchanged): one receipt per transaction.
    v_receipt_no := 'RCT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(NEXTVAL('receipt_no_seq')::TEXT, 4, '0');

    INSERT INTO receipts (school_id, receipt_no, student_id, total_amount, issued_at, issued_by, remarks)
    VALUES (NEW.school_id, v_receipt_no, v_student_id, NEW.amount, NEW.paid_at, NEW.received_by, COALESCE(NEW.remarks, 'System Generated'))
    RETURNING id INTO v_receipt_id;

    INSERT INTO receipt_items (school_id, receipt_id, fee_transaction_id, amount)
    VALUES (NEW.school_id, v_receipt_id, NEW.id, NEW.amount);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

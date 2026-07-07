
-- Trigger to propagate fee structure changes to student fees

CREATE OR REPLACE FUNCTION propagate_fee_structure_updates()
RETURNS TRIGGER AS $$
BEGIN
    -- Only proceed if the amount has changed
    IF NEW.amount IS DISTINCT FROM OLD.amount THEN
        -- Update linked student_fees
        -- We only update fees that are 'pending', 'partial', or 'overdue'
        -- We do NOT update 'paid' fees or 'waived' fees typically, but let's stick to active dues.
        -- Logic:
        -- New Amount Due = NEW.amount
        -- Status needs re-evaluation:
        --   If Amount Paid >= (New Amount - Discount), then Paid.
        --   Else if Amount Paid > 0, Partial.
        --   Else Pending.
        
        UPDATE student_fees
        SET 
            amount_due = NEW.amount,
            updated_at = now(),
            status = CASE 
                WHEN amount_paid >= (NEW.amount - discount) THEN 'paid'::fee_status_enum
                WHEN amount_paid > 0 THEN 'partial'::fee_status_enum
                WHEN due_date < CURRENT_DATE THEN 'overdue'::fee_status_enum
                ELSE 'pending'::fee_status_enum
            END
        WHERE fee_structure_id = NEW.id
          AND status IN ('pending', 'partial', 'overdue');
          
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_propagate_fee_updates ON fee_structures;
CREATE TRIGGER trg_propagate_fee_updates
AFTER UPDATE ON fee_structures
FOR EACH ROW EXECUTE FUNCTION propagate_fee_structure_updates();

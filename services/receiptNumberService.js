/**
 * Allocate the next receipt number for one school inside the caller's database
 * transaction. Keeping this call centralized prevents receipt-producing routes
 * from accidentally falling back to the legacy global sequence.
 */
export async function generateReceiptNo(tx, schoolId) {
  const [row] = await tx`
    SELECT public.get_next_receipt_no(${schoolId}) AS receipt_no
  `;

  if (!row?.receipt_no) {
    throw new Error('Failed to allocate a receipt number');
  }

  return row.receipt_no;
}

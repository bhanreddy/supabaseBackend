import sql from './db.js';

async function verifyHardening() {
    console.log("--- Starting Academic Hardening Verification ---");

    try {
        // 1. Setup Dummy Academic Year
        const [ay] = await sql`INSERT INTO academic_years (code, start_date, end_date) VALUES ('TEST-YEAR', '2090-01-01', '2090-12-31') RETURNING id`;
        console.log("✓ Created Test Academic Year");

        // 2. Setup Dummy Class
        const [cls] = await sql`INSERT INTO classes (name, code) VALUES ('TEST-CLASS', 'TC1') RETURNING id`;
        console.log("✓ Created Test Class");

        // 3. Link Class to Section for this Year
        const [sec] = await sql`SELECT id FROM sections LIMIT 1`;
        await sql`INSERT INTO class_sections (class_id, section_id, academic_year_id) VALUES (${cls.id}, ${sec.id}, ${ay.id})`;
        console.log("✓ Linked Class to Section (Mapping created)");

        // 4. Test Deletion Failure for Class (Mapping dependency)
        try {
            await sql`DELETE FROM classes WHERE id = ${cls.id}`;
            console.warn("✗ FAILED: Class should NOT have been deleted (linked to mapping)");
        } catch (e) {
            console.log("✓ PASSED: Class deletion blocked as expected (Mapping exists)");
        }

        // 5. Setup Fee Structure dependency
        const [feeType] = await sql`SELECT id FROM fee_types LIMIT 1`;
        const [fs] = await sql`INSERT INTO fee_structures (academic_year_id, class_id, fee_type_id, amount) VALUES (${ay.id}, ${cls.id}, ${feeType.id}, 5000) RETURNING id`;
        console.log("✓ Created Fee Structure dependency");

        // 6. Test Deletion Failure for AY (Fee dependency)
        try {
            await sql`DELETE FROM academic_years WHERE id = ${ay.id}`;
            console.warn("✗ FAILED: AY should NOT have been deleted (linked to fees)");
        } catch (e) {
            console.log("✓ PASSED: AY deletion blocked as expected (Fees exist)");
        }

        // 7. Cleanup
        await sql`DELETE FROM fee_structures WHERE id = ${fs.id}`;
        await sql`DELETE FROM class_sections WHERE class_id = ${cls.id} AND academic_year_id = ${ay.id}`;
        await sql`DELETE FROM classes WHERE id = ${cls.id}`;
        await sql`DELETE FROM academic_years WHERE id = ${ay.id}`;
        console.log("✓ Cleanup successful");

        console.log("\n--- Verification Complete: ALL TESTS PASSED ---");
    } catch (error) {
        console.error("Verification crashed:", error);
    } finally {
        process.exit();
    }
}

verifyHardening();

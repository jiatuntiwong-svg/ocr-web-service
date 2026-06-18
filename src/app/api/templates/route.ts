import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fail, ErrorCode } from "@/lib/apiResponse";
import { requireUser, ensureCanActAs } from "@/lib/auth/guards";


// แม่แบบมาตรฐาน (Global Templates)
const GLOBAL_TEMPLATES = [
    {
        id: "global-invoice",
        user_id: "system",
        name: "Standard Invoice (ใบแจ้งหนี้)",
        fields_json: JSON.stringify([
            { id: "i1", name: "ชื่อผู้ขาย", type: "text" },
            { id: "i2", name: "เลขที่ใบแจ้งหนี้", type: "text" },
            { id: "i3", name: "วันที่", type: "date" },
            { id: "i4", name: "ยอดรวมสุทธิ", type: "currency" },
            { id: "i5", name: "ภาษีมูลค่าเพิ่ม (VAT)", type: "currency" },
            { id: "i6", name: "ตารางรายการสินค้า", type: "table" }
        ])
    },
    {
        id: "global-po",
        user_id: "system",
        name: "Purchase Order (ใบสั่งซื้อ)",
        fields_json: JSON.stringify([
            { id: "p1", name: "เลขที่ PO", type: "text" },
            { id: "p2", name: "ชื่อผู้จัดจำหน่าย", type: "text" },
            { id: "p3", name: "วันที่สั่งซื้อ", type: "date" },
            { id: "p4", name: "ยอดรวมทั้งหมด", type: "currency" },
            { id: "p5", name: "เงื่อนไขการชำระเงิน", type: "text" },
            { id: "p6", name: "รายการสินค้า", type: "table" }
        ])
    },
    {
        id: "global-receipt",
        user_id: "system",
        name: "Cash Receipt (ใบเสร็จรับเงิน)",
        fields_json: JSON.stringify([
            { id: "r1", name: "ชื่อร้านค้า/บริษัท", type: "text" },
            { id: "r2", name: "เลขที่ใบเสร็จ", type: "text" },
            { id: "r3", name: "วันที่ชำระเงิน", type: "date" },
            { id: "r4", name: "ยอดชำระสุทธิ", type: "currency" },
            { id: "r5", name: "รายการ", type: "table" }
        ])
    },
    {
        id: "global-id-card",
        user_id: "system",
        name: "Thai ID Card (บัตรประชาชน)",
        fields_json: JSON.stringify([
            { id: "id1", name: "เลขประจำตัวประชาชน", type: "text" },
            { id: "id2", name: "ชื่อ-นามสกุล (TH)", type: "text" },
            { id: "id3", name: "ชื่อ-นามสกุล (EN)", type: "text" },
            { id: "id4", name: "วันเกิด", type: "date" },
            { id: "id5", name: "ที่อยู่", type: "address" },
            { id: "id6", name: "วันออกบัตร/หมดอายุ", type: "text" }
        ])
    },
    {
        id: "global-passport",
        user_id: "system",
        name: "Passport (หนังสือเดินทาง)",
        fields_json: JSON.stringify([
            { id: "pass1", name: "เลขที่หนังสือเดินทาง", type: "text" },
            { id: "pass2", name: "ชื่อ-นามสกุล", type: "text" },
            { id: "pass3", name: "สัญชาติ", type: "text" },
            { id: "pass4", name: "วันเกิด", type: "date" },
            { id: "pass5", name: "เพศ", type: "text" },
            { id: "pass6", name: "วันหมดอายุ", type: "date" }
        ])
    },
    {
        id: "global-bol",
        user_id: "system",
        name: "Bill of Lading (ใบตราส่งสินค้า)",
        fields_json: JSON.stringify([
            { id: "bol1", name: "เลขที่ B/L", type: "text" },
            { id: "bol2", name: "ผู้ส่งสินค้า (Shipper)", type: "text" },
            { id: "bol3", name: "ผู้รับสินค้า (Consignee)", type: "text" },
            { id: "bol4", name: "ท่าเรือต้นทาง/ปลายทาง", type: "text" },
            { id: "bol5", name: "รายการตู้สินค้า/น้ำหนัก", type: "table" }
        ])
    },
    {
        id: "global-medical",
        user_id: "system",
        name: "Medical Certificate (ใบรับรองแพทย์)",
        fields_json: JSON.stringify([
            { id: "med1", name: "ชื่อผู้ป่วย", type: "text" },
            { id: "med2", name: "ชื่อโรงพยาบาล/คลินิก", type: "text" },
            { id: "med3", name: "ผลการวินิจฉัย", type: "text" },
            { id: "med4", name: "วันที่ตรวจ", type: "date" },
            { id: "med5", name: "ความเห็นแพทย์ (ให้พักกี่วัน)", type: "text" }
        ])
    }
];

// ดึง Template ทั้งหมดของผู้ใช้ + Global
export async function GET(request: NextRequest) {
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;

    const { searchParams } = new URL(request.url);
    const requested = searchParams.get("userId") ?? auth.id;
    const cross = ensureCanActAs(auth, requested);
    if (cross) return cross;
    const userId = requested;

    try {
        const { env } = await getCloudflareContext();
        const userTemplates = await env.DB.prepare("SELECT * FROM templates WHERE user_id = ? ORDER BY created_at DESC")
            .bind(userId)
            .all();

        // รวม Global Templates เข้าไปดัวย
        return NextResponse.json([...GLOBAL_TEMPLATES, ...userTemplates.results]);
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "templates" });
    }
}

// Save or overwrite a template. When `id` is provided, UPDATE the existing
// row (overwrite-in-place save); otherwise INSERT a new row. The ownership
// check on UPDATE prevents one user from clobbering another user's template
// by guessing IDs.
export async function POST(request: NextRequest) {
    try {
        const auth = await requireUser(request);
        if (auth instanceof Response) return auth;

        const body = (await request.json()) as { userId?: string; name: string; fields: any; id?: string };
        const { name, fields, id: providedId } = body;
        const requested = body.userId ?? auth.id;
        const cross = ensureCanActAs(auth, requested);
        if (cross) return cross;
        const userId = requested;

        if (!name || !fields) {
            return fail(ErrorCode.MISSING_FIELDS, { context: "templates-save" });
        }

        const { env } = await getCloudflareContext();

        if (providedId) {
            const result = await env.DB.prepare(
                "UPDATE templates SET name = ?, fields_json = ? WHERE id = ? AND user_id = ?"
            )
                .bind(name, JSON.stringify(fields), providedId, userId)
                .run();
            const changed = (result as any)?.meta?.changes ?? 0;
            if (changed === 0) {
                return fail(ErrorCode.NOT_FOUND, { context: "templates-update" });
            }
            return NextResponse.json({ success: true, id: providedId, updated: true });
        }

        const id = crypto.randomUUID();
        await env.DB.prepare(
            "INSERT INTO templates (id, user_id, name, fields_json) VALUES (?, ?, ?, ?)"
        )
            .bind(id, userId, name, JSON.stringify(fields))
            .run();

        return NextResponse.json({ success: true, id });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "templates" });
    }
}

// ลบ Template
export async function DELETE(request: NextRequest) {
    const auth = await requireUser(request);
    if (auth instanceof Response) return auth;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const requested = searchParams.get("userId") ?? auth.id;
    const cross = ensureCanActAs(auth, requested);
    if (cross) return cross;
    const userId = requested;

    if (!id) {
        return fail(ErrorCode.MISSING_FIELDS, { context: "templates-delete" });
    }

    try {
        const { env } = await getCloudflareContext();
        await env.DB.prepare("DELETE FROM templates WHERE id = ? AND user_id = ?")
            .bind(id, userId)
            .run();

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return fail(ErrorCode.SERVER_ERROR, { detail: error, context: "templates" });
    }
}

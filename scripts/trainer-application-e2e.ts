import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';

/**
 * Consultant application end-to-end verification against a running API server.
 *
 * Walks the full loop: participant signs up -> the old self-service upgrade is refused -> saves
 * details (agreement issued) -> downloads the personalised PDF -> is still kept out of trainer
 * endpoints -> bad uploads are rejected -> uploads the signed copy -> admin requests changes ->
 * applicant re-uploads -> admin approves -> account is a trainer with a billing profile and the
 * Business console shows the agreement as signed. Then an admin attaches a paper-signed copy for
 * an existing trainer. Cleans up every user and file it created.
 *
 * Start the server with email off so nobody is emailed:
 *   EMAIL_ENABLED=false npm run dev:server
 * Run: npx tsx scripts/trainer-application-e2e.ts [api-base-url]
 */

const API = process.argv[2] ?? 'http://localhost:3001';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = 'AgreementE2E#Test!2026';
const RUN_ID = Date.now().toString(36);
const APPLICANT_EMAIL = `agreement-e2e-applicant-${RUN_ID}@loadtest.example.com`;
const TRAINER_EMAIL = `agreement-e2e-trainer-${RUN_ID}@loadtest.example.com`;
const ADMIN_EMAIL = `agreement-e2e-admin-${RUN_ID}@loadtest.example.com`;
const BUCKET = 'trainer-agreements';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let passCount = 0;
let failCount = 0;
const expect = (cond: boolean, msg: string) => {
  if (cond) {
    passCount++;
    console.log(`  PASS  ${msg}`);
  } else {
    failCount++;
    console.log(`  FAIL  ${msg}`);
  }
};

async function createUser(
  email: string,
  fullName: string,
): Promise<{ userId: string; token: string }> {
  const { error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName, agency_name: 'E2E Test' },
  });
  if (error && !/already/i.test(error.message)) throw new Error(error.message);
  const client = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error: signInError } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (signInError || !data.session) throw new Error(signInError?.message ?? 'sign-in failed');
  return { userId: data.user!.id, token: data.session.access_token };
}

async function apiCall(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

async function download(path: string, token: string) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    bytes: new Uint8Array(await res.arrayBuffer()),
  };
}

async function upload(
  path: string,
  token: string,
  file: Uint8Array,
  name = 'signed.pdf',
  type = 'application/pdf',
) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)], { type }), name);
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: bytes.slice() });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

async function paperScanStandIn(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    doc
      .addPage([595, 842])
      .drawText(`Signed on paper, page ${i + 1}`, { x: 60, y: 760, size: 12, font });
  }
  return doc.save();
}

async function roleOf(userId: string): Promise<string | null> {
  const { data } = await admin.from('user_profiles').select('role').eq('id', userId).single();
  return (data?.role as string | undefined) ?? null;
}

async function removeUserFiles(userId: string): Promise<void> {
  const { data: folders } = await admin.storage.from(BUCKET).list(userId);
  for (const folder of folders ?? []) {
    const { data: files } = await admin.storage.from(BUCKET).list(`${userId}/${folder.name}`);
    const paths = (files ?? []).map((f) => `${userId}/${folder.name}/${f.name}`);
    if (paths.length > 0) await admin.storage.from(BUCKET).remove(paths);
  }
}

async function main() {
  console.log(`\n=== Consultant application E2E (run ${RUN_ID}) against ${API} ===\n`);
  const created: string[] = [];

  try {
    // ── 1. A new account starts as a participant ─────────────────────────
    console.log('1. Signup and the closed self-service door');
    const applicant = await createUser(APPLICANT_EMAIL, 'Agreement E2E Applicant');
    created.push(applicant.userId);
    expect((await roleOf(applicant.userId)) === 'participant', 'new account is a participant');
    const become = await apiCall('POST', '/api/profile/become-trainer', applicant.token);
    expect(become.status !== 200, `self-service trainer upgrade is refused (got ${become.status})`);
    expect((await roleOf(applicant.userId)) === 'participant', 'role is still participant');

    // ── 2. The agreement is issued when details are saved ────────────────
    console.log('\n2. Issuing the agreement');
    const current = await apiCall('GET', '/api/trainer-agreements/current', null);
    const info = current.json.data as { version: string; pageCount: number; fields: string[] };
    expect(current.status === 200 && info.fields.includes('full_name'), 'public agreement info');

    const empty = await apiCall('GET', '/api/trainer-agreements/mine', applicant.token);
    expect(
      empty.status === 200 && empty.json.data.current === null,
      'no agreement before applying',
    );

    const unprintable = await apiCall('PUT', '/api/trainer-agreements/mine', applicant.token, {
      full_name: '陈大文',
      contact_number: '+65 9123 4567',
      address: '1 Test Road, Singapore 000001',
    });
    expect(unprintable.status === 400, `unprintable name rejected (got ${unprintable.status})`);

    if (info.fields.includes('address')) {
      const noAddress = await apiCall('PUT', '/api/trainer-agreements/mine', applicant.token, {
        full_name: 'Agreement E2E Applicant',
        contact_number: '+65 9123 4567',
      });
      expect(noAddress.status === 400, `missing address rejected (got ${noAddress.status})`);
    }

    const details = {
      full_name: 'Agreement E2E Applicant',
      contact_number: '+65 9123 4567',
      address: '1 Test Road, Singapore 000001',
      organisation: 'E2E Consulting',
    };
    const saved = await apiCall('PUT', '/api/trainer-agreements/mine', applicant.token, details);
    const agreementId = saved.json.data?.id as string;
    const reference = saved.json.data?.reference as string;
    expect(saved.status === 201, `details saved (got ${saved.status})`);
    expect(saved.json.data?.status === 'awaiting_signature', 'agreement awaits a signature');
    expect(/^PCA-[A-Z0-9]{8}$/.test(reference ?? ''), `reference issued (${reference})`);

    const resaved = await apiCall('PUT', '/api/trainer-agreements/mine', applicant.token, {
      ...details,
      contact_number: '+65 8123 4567',
    });
    expect(
      resaved.status === 200 &&
        resaved.json.data?.id === agreementId &&
        resaved.json.data?.reference === reference,
      'editing details re-issues the same agreement',
    );

    // ── 3. Still no trainer access ────────────────────────────────────────
    console.log('\n3. Access while applying');
    const orgs = await apiCall('GET', '/api/billing/organisations', applicant.token);
    expect(orgs.status === 403, `trainer endpoints still refused (got ${orgs.status})`);
    const adminList = await apiCall('GET', '/api/trainer-agreements/admin', applicant.token);
    expect(
      adminList.status === 403,
      `admin review refused for applicants (got ${adminList.status})`,
    );

    // ── 4. The personalised PDF ──────────────────────────────────────────
    console.log('\n4. Downloading the agreement');
    const doc = await download('/api/trainer-agreements/mine/document', applicant.token);
    expect(doc.status === 200 && doc.contentType === 'application/pdf', 'PDF served');
    const text = await pdfText(doc.bytes);
    expect(
      text.includes(reference) && text.includes(APPLICANT_EMAIL),
      'PDF carries the reference and email',
    );
    expect(text.includes('+65 8123 4567'), 'PDF carries the corrected contact number');

    // ── 5. Uploads ───────────────────────────────────────────────────────
    console.log('\n5. Uploading the signed copy');
    const notPdf = await upload(
      '/api/trainer-agreements/mine/signed',
      applicant.token,
      new TextEncoder().encode('these are my notes'),
      'notes.txt',
      'text/plain',
    );
    expect(notPdf.status === 400, `non-PDF rejected (got ${notPdf.status})`);

    const first = await upload('/api/trainer-agreements/mine/signed', applicant.token, doc.bytes);
    expect(
      first.status === 200 && first.json.data?.status === 'submitted',
      `upload submitted (got ${first.status})`,
    );
    const { data: row1 } = await admin
      .from('trainer_agreements')
      .select('*')
      .eq('id', agreementId)
      .single();
    expect(
      row1?.signed_file_pages === info.pageCount,
      `page count recorded (${row1?.signed_file_pages})`,
    );
    expect(row1?.signed_file_has_reference === true, 'reference found in the upload');

    const again = await upload('/api/trainer-agreements/mine/signed', applicant.token, doc.bytes);
    expect(again.status === 409, `no second upload while under review (got ${again.status})`);

    // ── 6. Admin review ──────────────────────────────────────────────────
    console.log('\n6. Admin review');
    const adminUser = await createUser(ADMIN_EMAIL, 'Agreement E2E Admin');
    created.push(adminUser.userId);
    await admin.from('user_profiles').update({ role: 'admin' }).eq('id', adminUser.userId);

    const review = await apiCall(
      'GET',
      '/api/trainer-agreements/admin?view=review',
      adminUser.token,
    );
    const item = (review.json.data?.items ?? []).find((i: { id: string }) => i.id === agreementId);
    expect(review.status === 200 && Boolean(item), 'application listed for review');
    expect(
      item?.expected_pages === info.pageCount && item?.user_role === 'participant',
      'review shows checks and role',
    );

    const signed = await apiCall(
      'GET',
      `/api/trainer-agreements/admin/${agreementId}/signed`,
      adminUser.token,
    );
    const signedFile = signed.json.data?.url ? await fetch(signed.json.data.url as string) : null;
    expect(signedFile?.status === 200, 'signed copy opens through a signed link');
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${row1?.signed_file_path}`;
    expect((await fetch(publicUrl)).status !== 200, 'signed copy is not publicly reachable');

    const early = await apiCall(
      'POST',
      `/api/trainer-agreements/admin/${agreementId}/request-changes`,
      adminUser.token,
      {},
    );
    expect(early.status === 400, `change request needs a note (got ${early.status})`);
    const changes = await apiCall(
      'POST',
      `/api/trainer-agreements/admin/${agreementId}/request-changes`,
      adminUser.token,
      { note: 'Please sign and date the last page.' },
    );
    expect(
      changes.status === 200 && changes.json.data?.status === 'changes_requested',
      'changes requested',
    );
    const mineAfter = await apiCall('GET', '/api/trainer-agreements/mine', applicant.token);
    expect(
      mineAfter.json.data?.current?.review_note === 'Please sign and date the last page.',
      'applicant sees the note',
    );
    const tooEarly = await apiCall(
      'POST',
      `/api/trainer-agreements/admin/${agreementId}/approve`,
      adminUser.token,
      {},
    );
    expect(tooEarly.status === 409, `cannot approve before re-upload (got ${tooEarly.status})`);

    const second = await upload('/api/trainer-agreements/mine/signed', applicant.token, doc.bytes);
    expect(
      second.status === 200 && second.json.data?.status === 'submitted',
      're-upload submitted',
    );
    const { data: row2 } = await admin
      .from('trainer_agreements')
      .select('signed_file_path')
      .eq('id', agreementId)
      .single();
    const { data: leftovers } = await admin.storage
      .from(BUCKET)
      .list(`${applicant.userId}/${agreementId}`);
    expect(
      (leftovers ?? []).length === 1 && row2?.signed_file_path !== row1?.signed_file_path,
      'earlier upload removed',
    );

    // ── 7. Approval ──────────────────────────────────────────────────────
    console.log('\n7. Approval');
    const approved = await apiCall(
      'POST',
      `/api/trainer-agreements/admin/${agreementId}/approve`,
      adminUser.token,
      {},
    );
    expect(
      approved.status === 200 && approved.json.data?.promoted === true,
      `approved and promoted (got ${approved.status})`,
    );
    expect((await roleOf(applicant.userId)) === 'trainer', 'account is now a trainer');
    const { data: billing } = await admin
      .from('trainer_billing')
      .select('onboarding_status')
      .eq('trainer_id', applicant.userId)
      .maybeSingle();
    expect(billing?.onboarding_status === 'none', 'billing profile created');
    const twice = await apiCall(
      'POST',
      `/api/trainer-agreements/admin/${agreementId}/approve`,
      adminUser.token,
      {},
    );
    expect(twice.status === 409, `cannot approve twice (got ${twice.status})`);
    const orgsAfter = await apiCall('GET', '/api/billing/organisations', applicant.token);
    expect(
      orgsAfter.status === 200,
      `trainer endpoints open after approval (got ${orgsAfter.status})`,
    );
    const mineApproved = await apiCall('GET', '/api/trainer-agreements/mine', applicant.token);
    expect(
      mineApproved.json.data?.onFile?.id === agreementId,
      'agreement on file for the new trainer',
    );
    const console1 = await apiCall('GET', '/api/billing/admin/trainers', adminUser.token);
    const listed = (console1.json.data ?? []).find(
      (t: { id: string }) => t.id === applicant.userId,
    );
    expect(
      listed?.agreement?.status === 'signed',
      'Business console shows the agreement as signed',
    );

    // ── 8. Existing trainer with a paper-signed copy ─────────────────────
    console.log('\n8. Attaching a paper-signed copy');
    const trainer = await createUser(TRAINER_EMAIL, 'Agreement E2E Trainer');
    created.push(trainer.userId);
    await admin.from('user_profiles').update({ role: 'trainer' }).eq('id', trainer.userId);
    const before = await apiCall('GET', '/api/billing/admin/trainers', adminUser.token);
    const unsigned = (before.json.data ?? []).find((t: { id: string }) => t.id === trainer.userId);
    expect(
      unsigned?.agreement?.status === 'none',
      'existing trainer starts with no agreement on file',
    );
    const refused = await upload(
      `/api/trainer-agreements/admin/trainers/${trainer.userId}/attach`,
      trainer.token,
      await paperScanStandIn(),
    );
    expect(refused.status === 403, `trainers cannot attach for themselves (got ${refused.status})`);
    const attached = await upload(
      `/api/trainer-agreements/admin/trainers/${trainer.userId}/attach`,
      adminUser.token,
      await paperScanStandIn(),
    );
    expect(attached.status === 201, `admin attached the copy (got ${attached.status})`);
    const trainerMine = await apiCall('GET', '/api/trainer-agreements/mine', trainer.token);
    expect(Boolean(trainerMine.json.data?.onFile), 'trainer now has an agreement on file');
    const broken = await upload(
      `/api/trainer-agreements/admin/trainers/${applicant.userId}/attach`,
      adminUser.token,
      new TextEncoder().encode('%PDF-1.7 broken'),
    );
    expect(broken.status === 400, `unreadable PDF refused on attach (got ${broken.status})`);
  } finally {
    console.log('\nCleanup');
    try {
      for (const userId of created) {
        await removeUserFiles(userId);
        await admin.from('trainer_billing').delete().eq('trainer_id', userId);
        await admin.auth.admin.deleteUser(userId);
      }
      console.log('  cleanup done');
    } catch (err) {
      console.log(`  cleanup issue (non-fatal): ${(err as Error).message}`);
    }
  }

  console.log(`\n=== Result: ${passCount} passed, ${failCount} failed ===\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nE2E crashed:', err);
  process.exit(1);
});

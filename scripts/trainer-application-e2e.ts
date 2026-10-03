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
 * Business console shows the agreement as signed and which admin approved it. Then an admin
 * attaches a paper-signed copy for an existing trainer, and enrolls a trainer from the console,
 * which a second admin can see along with who enrolled them. Finally checks that someone who signed
 * up to apply but has not saved their details is listed for admins, and only for admins. Uploading
 * a signed copy only saves it; submitting is a separate step, and until it is done a consultant
 * sign-up or a trainer enrolled from the console is held at the form (GET /api/profile reports
 * contract_required). Cleans up every user and file it created.
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
const SECOND_ADMIN_EMAIL = `agreement-e2e-admin2-${RUN_ID}@loadtest.example.com`;
const ENROLLED_EMAIL = `agreement-e2e-enrolled-${RUN_ID}@loadtest.example.com`;
const UNSTARTED_EMAIL = `agreement-e2e-unstarted-${RUN_ID}@loadtest.example.com`;
const PLAIN_EMAIL = `agreement-e2e-plain-${RUN_ID}@loadtest.example.com`;
const GATED_EMAIL = `agreement-e2e-gated-${RUN_ID}@loadtest.example.com`;
const LEGACY_EMAIL = `agreement-e2e-legacy-${RUN_ID}@loadtest.example.com`;
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
  extraMetadata: Record<string, unknown> = {},
): Promise<{ userId: string; token: string }> {
  const { error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName, agency_name: 'E2E Test', ...extraMetadata },
  });
  if (error && !/already/i.test(error.message)) throw new Error(error.message);
  return signIn(email, PASSWORD);
}

async function signIn(email: string, password: string): Promise<{ userId: string; token: string }> {
  const client = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error: signInError } = await client.auth.signInWithPassword({ email, password });
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
    });
    expect(unprintable.status === 400, `unprintable name rejected (got ${unprintable.status})`);

    // No address is asked for: the form does not have the field and the API does not need it.
    const details = {
      full_name: 'Agreement E2E Applicant',
      contact_number: '+65 9123 4567',
      organisation: 'E2E Consulting',
    };
    const saved = await apiCall('PUT', '/api/trainer-agreements/mine', applicant.token, details);
    const agreementId = saved.json.data?.id as string;
    const reference = saved.json.data?.reference as string;
    expect(saved.status === 201, `details saved without an address (got ${saved.status})`);
    expect(saved.json.data?.status === 'awaiting_signature', 'agreement awaits a signature');
    expect(/^PCA-[A-Z0-9]{8}$/.test(reference ?? ''), `reference issued (${reference})`);

    const olderPage = await apiCall('PUT', '/api/trainer-agreements/mine', applicant.token, {
      ...details,
      address: '1 Test Road, Singapore 000001',
    });
    expect(
      olderPage.status === 200 && (olderPage.json.data?.address ?? null) === null,
      `an address sent by an older page is ignored, not stored (got ${olderPage.status})`,
    );

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

    const earlySubmit = await apiCall(
      'POST',
      '/api/trainer-agreements/mine/submit',
      applicant.token,
    );
    expect(
      earlySubmit.status === 409,
      `cannot submit before a signed copy is saved (got ${earlySubmit.status})`,
    );

    const first = await upload('/api/trainer-agreements/mine/signed', applicant.token, doc.bytes);
    expect(
      first.status === 200 &&
        first.json.data?.status === 'awaiting_signature' &&
        first.json.data?.copy_uploaded === true &&
        first.json.data?.copy_pages === info.pageCount,
      `upload is saved as a draft, not submitted (got ${first.status} / ${first.json.data?.status})`,
    );
    const { data: draftRow } = await admin
      .from('trainer_agreements')
      .select('submitted_at, signed_file_uploaded_at')
      .eq('id', agreementId)
      .single();
    expect(
      draftRow?.submitted_at === null && Boolean(draftRow?.signed_file_uploaded_at),
      'nothing is marked submitted by uploading',
    );
    const viewDraft = await apiCall('GET', '/api/trainer-agreements/mine/signed', applicant.token);
    expect(
      viewDraft.status === 200 && Boolean(viewDraft.json.data?.url),
      'the applicant can open their saved copy',
    );

    // Saving the form again without changing anything must not throw the signed copy away.
    const noop = await apiCall('PUT', '/api/trainer-agreements/mine', applicant.token, {
      ...details,
      contact_number: '+65 8123 4567',
    });
    expect(
      noop.status === 200 && noop.json.data?.copy_uploaded === true,
      'saving unchanged details keeps the signed copy',
    );

    const replaced = await upload(
      '/api/trainer-agreements/mine/signed',
      applicant.token,
      doc.bytes,
    );
    const { data: filesAfterReplace } = await admin.storage
      .from(BUCKET)
      .list(`${applicant.userId}/${agreementId}`);
    expect(
      replaced.status === 200 && (filesAfterReplace ?? []).length === 1,
      'replacing the saved copy leaves exactly one file',
    );

    const submitted = await apiCall('POST', '/api/trainer-agreements/mine/submit', applicant.token);
    expect(
      submitted.status === 200 &&
        submitted.json.data?.status === 'submitted' &&
        submitted.json.data?.copy_uploaded === false,
      `application submitted as a separate step (got ${submitted.status})`,
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
    const submitAgain = await apiCall(
      'POST',
      '/api/trainer-agreements/mine/submit',
      applicant.token,
    );
    expect(submitAgain.status === 409, `no second submission (got ${submitAgain.status})`);

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
      second.status === 200 &&
        second.json.data?.status === 'changes_requested' &&
        second.json.data?.copy_uploaded === true,
      're-upload is saved as a draft while the changes are still pending',
    );
    const stillPending = await apiCall(
      'POST',
      `/api/trainer-agreements/admin/${agreementId}/approve`,
      adminUser.token,
      {},
    );
    expect(
      stillPending.status === 409,
      `cannot approve until the corrected copy is submitted (got ${stillPending.status})`,
    );
    const resubmitted = await apiCall(
      'POST',
      '/api/trainer-agreements/mine/submit',
      applicant.token,
    );
    expect(
      resubmitted.status === 200 && resubmitted.json.data?.status === 'submitted',
      'corrected application submitted',
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
    expect(
      listed?.enrollment?.via === 'application' &&
        listed?.enrollment?.by_id === adminUser.userId &&
        listed?.enrollment?.by_name === 'Agreement E2E Admin' &&
        Boolean(listed?.enrollment?.at),
      'console records the admin who approved the application',
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
    expect(
      unsigned?.enrollment?.via === null && unsigned?.enrollment?.by_id === null,
      'a trainer created outside the console shows as not recorded',
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

    // ── 9. Enrolling a trainer from the console records who did it ───────
    console.log('\n9. Enrolling a trainer from the console');
    const enrollBody = {
      email: ENROLLED_EMAIL,
      full_name: 'Agreement E2E Enrolled',
      agency_name: 'E2E Test',
    };
    const notAllowed = await apiCall(
      'POST',
      '/api/billing/admin/trainers',
      trainer.token,
      enrollBody,
    );
    expect(
      notAllowed.status === 403,
      `a trainer cannot enroll trainers (got ${notAllowed.status})`,
    );
    const enrolled = await apiCall(
      'POST',
      '/api/billing/admin/trainers',
      adminUser.token,
      enrollBody,
    );
    expect(enrolled.status === 201, `admin enrolled a trainer (got ${enrolled.status})`);
    const enrolledId = enrolled.json.data?.id as string;
    if (enrolledId) created.push(enrolledId);

    const afterEnroll = await apiCall('GET', '/api/billing/admin/trainers', adminUser.token);
    const enrolledListed = (afterEnroll.json.data ?? []).find(
      (t: { id: string }) => t.id === enrolledId,
    );
    expect(
      enrolledListed?.enrollment?.via === 'admin_enrollment' &&
        enrolledListed?.enrollment?.by_id === adminUser.userId &&
        enrolledListed?.enrollment?.by_name === 'Agreement E2E Admin' &&
        Boolean(enrolledListed?.enrollment?.at),
      'console records the admin who enrolled the trainer',
    );
    const { data: billingRow } = await admin
      .from('trainer_billing')
      .select('onboarding_status, enrolled_by')
      .eq('trainer_id', enrolledId)
      .maybeSingle();
    expect(
      billingRow?.onboarding_status === 'none' && billingRow?.enrolled_by === adminUser.userId,
      'billing profile created alongside the record',
    );

    // Admin is one global role: a second admin sees the same trainers, and who enrolled each.
    const secondAdmin = await createUser(SECOND_ADMIN_EMAIL, 'Agreement E2E Second Admin');
    created.push(secondAdmin.userId);
    await admin.from('user_profiles').update({ role: 'admin' }).eq('id', secondAdmin.userId);
    const seenBySecond = await apiCall('GET', '/api/billing/admin/trainers', secondAdmin.token);
    const seen = (seenBySecond.json.data ?? []).find((t: { id: string }) => t.id === enrolledId);
    expect(
      seenBySecond.status === 200 &&
        seen?.enrollment?.by_id === adminUser.userId &&
        seen?.enrollment?.by_name === 'Agreement E2E Admin',
      'a second admin sees that trainer and which admin enrolled them',
    );

    // ── 10. Applicants who signed up but have not saved their details ────
    console.log('\n10. Applicants who signed up but have not started');
    const unstarted = await createUser(UNSTARTED_EMAIL, 'Agreement E2E Unstarted', {
      applying_as_consultant: true,
    });
    created.push(unstarted.userId);
    const plain = await createUser(PLAIN_EMAIL, 'Agreement E2E Plain Participant');
    created.push(plain.userId);

    type Waiting = { user_id: string; email: string; email_confirmed: boolean };
    const waitingList = async (view: string, token: string) => {
      const res = await apiCall('GET', `/api/trainer-agreements/admin?view=${view}`, token);
      return {
        status: res.status,
        notStarted: (res.json.data?.not_started ?? []) as Waiting[],
        items: (res.json.data?.items ?? []) as Array<{ user_id: string; status: string }>,
        inProgressCount: res.json.data?.counts?.in_progress as number,
      };
    };

    const before10 = await waitingList('in_progress', adminUser.token);
    const waiting = before10.notStarted.find((w) => w.user_id === unstarted.userId);
    expect(
      Boolean(waiting) && waiting?.email === UNSTARTED_EMAIL && waiting?.email_confirmed === true,
      'an applicant who has not started is listed for admins, with their email',
    );
    expect(
      !before10.notStarted.some((w) => w.user_id === plain.userId),
      'a participant who never applied is not listed',
    );
    expect(
      before10.inProgressCount >= before10.notStarted.length && before10.notStarted.length > 0,
      'they are counted under In progress',
    );
    const reviewView = await waitingList('review', adminUser.token);
    expect(
      reviewView.notStarted.length === 0,
      'the other tabs do not carry them (they come with In progress only)',
    );

    const notAdmin = await apiCall(
      'GET',
      '/api/trainer-agreements/admin?view=in_progress',
      unstarted.token,
    );
    expect(notAdmin.status === 403, `the list is admin-only (got ${notAdmin.status})`);

    // The listing function reads auth.users, so the public RPC surface must refuse it.
    const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/unstarted_consultant_applicants`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${unstarted.token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const rpcBody = await rpc.text();
    expect(
      !rpc.ok && !rpcBody.includes(UNSTARTED_EMAIL),
      `the database function is closed to signed-in users (got ${rpc.status})`,
    );

    // Once they save their details the application exists, so they move to the real list.
    const started = await apiCall('PUT', '/api/trainer-agreements/mine', unstarted.token, {
      full_name: 'Agreement E2E Unstarted',
      contact_number: '+65 9000 0001',
    });
    expect(started.status === 201, `they saved their details (got ${started.status})`);
    const after10 = await waitingList('in_progress', adminUser.token);
    expect(
      !after10.notStarted.some((w) => w.user_id === unstarted.userId) &&
        after10.items.some(
          (i) => i.user_id === unstarted.userId && i.status === 'awaiting_signature',
        ),
      'after saving details they move from "no details yet" to an application in progress',
    );

    // -- 11. Held at the application form until it is submitted --------------
    console.log('\n11. Held at the application form until it is submitted');
    const held = async (token: string) =>
      (await apiCall('GET', '/api/profile', token)).json.data?.contract_required as
        | boolean
        | undefined;

    const gated = await createUser(GATED_EMAIL, 'Agreement E2E Gated', {
      applying_as_consultant: true,
    });
    created.push(gated.userId);
    expect(
      (await held(gated.token)) === true,
      'a consultant sign-up is held before they have saved any details',
    );
    const gatedDetails = {
      full_name: 'Agreement E2E Gated',
      contact_number: '+65 9000 0002',
    };
    const g1 = await apiCall('PUT', '/api/trainer-agreements/mine', gated.token, gatedDetails);
    expect(
      g1.status === 201 && (await held(gated.token)) === true,
      'still held after saving their details',
    );
    const gatedDoc = await download('/api/trainer-agreements/mine/document', gated.token);
    const g2 = await upload('/api/trainer-agreements/mine/signed', gated.token, gatedDoc.bytes);
    expect(
      g2.status === 200 && (await held(gated.token)) === true,
      'still held with a signed copy saved but not submitted',
    );

    const g3 = await apiCall('PUT', '/api/trainer-agreements/mine', gated.token, {
      ...gatedDetails,
      contact_number: '+65 9000 0003',
    });
    const { data: staleFiles } = await admin.storage
      .from(BUCKET)
      .list(`${gated.userId}/${g3.json.data?.id}`);
    expect(
      g3.status === 200 && g3.json.data?.copy_uploaded === false && (staleFiles ?? []).length === 0,
      'changing the details removes the old signed copy and its file',
    );

    const gatedDoc2 = await download('/api/trainer-agreements/mine/document', gated.token);
    await upload('/api/trainer-agreements/mine/signed', gated.token, gatedDoc2.bytes);
    const g4 = await apiCall('POST', '/api/trainer-agreements/mine/submit', gated.token);
    expect(
      g4.status === 200 && (await held(gated.token)) === false,
      'the hold lifts once the application is submitted',
    );

    expect((await held(plain.token)) === false, 'an ordinary participant is never held');
    expect((await held(adminUser.token)) === false, 'an admin is never held');
    const legacy = await createUser(LEGACY_EMAIL, 'Agreement E2E Legacy Trainer');
    created.push(legacy.userId);
    await admin.from('user_profiles').update({ role: 'trainer' }).eq('id', legacy.userId);
    expect(
      (await held(legacy.token)) === false,
      'a trainer from before enrollment records keeps their access',
    );

    const enrolledSession = await signIn(
      ENROLLED_EMAIL,
      enrolled.json.data?.temporary_password as string,
    );
    expect(
      (await held(enrolledSession.token)) === true,
      'a trainer enrolled from the console is held until they submit',
    );
    const e1 = await apiCall('PUT', '/api/trainer-agreements/mine', enrolledSession.token, {
      full_name: 'Agreement E2E Enrolled',
      contact_number: '+65 9000 0004',
    });
    expect(
      e1.status === 201 && e1.json.data?.purpose === 'existing_trainer',
      'they can still reach the form and start their agreement',
    );
    const enrolledDoc = await download(
      '/api/trainer-agreements/mine/document',
      enrolledSession.token,
    );
    await upload('/api/trainer-agreements/mine/signed', enrolledSession.token, enrolledDoc.bytes);
    const e2 = await apiCall('POST', '/api/trainer-agreements/mine/submit', enrolledSession.token);
    expect(
      e2.status === 200 && (await held(enrolledSession.token)) === false,
      'and are released once they submit',
    );
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

# HealthConnect Bharat 2.0

HealthConnect Bharat is a healthcare discovery and appointment-request application built with Node.js, Express, EJS, HTML, CSS, browser JavaScript, and MySQL/TiDB. Email verification confirms control of an email address; it does not verify a medical licence. This project is not a clinical system and must not be used for emergency care.

## Requirements

- Node.js 20 or later and npm.
- A MySQL 8 compatible database or TiDB Cloud database with TLS and network access enabled.
- An SMTP relay such as Brevo for production email verification and password reset.

## Install and run

1. Open this project folder in VS Code and create a local `.env` from `.env.example`.
2. Add the database hostname, port, database, username, password, and a unique session secret. For TiDB, use its TLS connection values and keep `DB_SSL=true`.
3. Configure the SMTP login, SMTP key, and verified sender if you want real email delivery. Do not put an API key in `SMTP_PASS`.
4. In the VS Code terminal, run:

   ```powershell
   npm install
   npm run db:init
   npm run db:migrate
   npm run dev
   ```

5. Open `http://localhost:3000`.

Run only one development server on port 3000 at a time. Stop it with Ctrl+C before starting it again. The first schema command creates the base `users` and `email_otps` tables. The migration command applies additive healthcare tables and records applied migration filenames in `schema_migrations`; repeat runs skip completed migrations. Review SQL and take a database backup before production migrations. No existing user rows are deleted by migration 001. Rollback should be a separately reviewed restore from backup; dropping healthcare tables may delete data created after migration.

TiDB Cloud may require the computer's current public IP in its network access list. The database TLS certificate is verified by default. Do not turn off certificate verification to work around connection failures.

## Profile photos across devices

Profile images are stored in MySQL so they remain available after sign-in from another device or after a Render deploy. Apply migration 011 with `npm run db:migrate`. To transfer photos from an older local checkout, make sure its `.env` points to the same database and the ignored `public/uploads/profiles` files are still present, then run `npm run db:migrate-profile-photos`. The script only migrates files it can find; an unavailable old image must be uploaded again from the account's Profile page.

## Patient medical assistant (optional)

The patient dashboard includes typed chat, browser voice dictation, and camera/gallery image attachments. To connect AI answers, choose an OpenAI-compatible chat-completions service and add `MEDICAL_AI_BASE_URL`, `MEDICAL_AI_API_KEY`, and `MEDICAL_AI_MODEL` to `.env`; use a model that accepts images if photo questions are needed. Keep the API key on the server. The assistant sends only the active conversation and selected image to that provider after the patient confirms the notice; HealthConnect does not store chat history or uploaded images. Voice dictation uses the browser's speech recognition and availability/privacy behavior depends on that browser. Without these settings, the interface displays a setup-needed notice and no external AI request is made.

## Online video consultations and demo payment

The consultation workflow uses the existing Node.js/Express/EJS/MySQL stack and LiveKit for real browser video/audio transport. Patients can request a call with an available verified doctor; the doctor accepts, both parties join a private server-issued room token, then either participant can end the call. Calls are not recorded. The LiveKit webhook reports membership, and the server records the official start/end time. A reconnect grace sweep settles calls when a participant remains disconnected.

**The website's payment flows are demo only. No real money is processed.** Online video consultations use the Demo Wallet. For face-to-face clinic appointments, doctors can save a UPI ID and upload a QR image; patients can choose cash at the clinic or simulate an online UPI payment. The appointment demo does not contact a bank or verify a UPI transfer. It records only a mock result and creates a booking reference/proof. No card details or payout credentials are requested.

### Environment and LiveKit setup

Add the following placeholders to `.env` (copy the full database and SMTP settings from `.env.example` too):

```dotenv
PAYMENT_MODE=MOCK
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
WEBRTC_STUN_SERVER=
WEBRTC_TURN_SERVER=
WEBRTC_TURN_USERNAME=
WEBRTC_TURN_CREDENTIAL=
```

Create a LiveKit Cloud project or configure a self-hosted LiveKit server and use its server URL and API credentials. In LiveKit, configure a webhook to `https://your-public-host/webhooks/livekit`, signed with the LiveKit API secret, and subscribe to `participant_joined`, `participant_left`, and `room_finished`. The server checks webhook signatures and only accepts the patient/doctor identities linked to that private consultation room.

LiveKit Cloud supplies TURN connectivity by default. Optional `WEBRTC_STUN_SERVER` and `WEBRTC_TURN_SERVER` values accept comma-separated ICE server URLs. When TURN is supplied, `WEBRTC_TURN_CREDENTIAL` is treated as the TURN REST shared secret; the backend derives a one-hour username/password pair and sends only those temporary credentials to the browser. Do not place a TURN shared secret in client JavaScript or commit it. Localhost can open a call if LiveKit is publicly reachable, but receiving webhooks on localhost requires a temporary HTTPS tunnel. A reliable internet route and LiveKit credentials are required for two-device video; localhost/demo payment alone does not fabricate a video call.

### Server-side billing

The database consultation rate defaults to ₹5/minute and can be adjusted by an administrator at `/admin/consultations`. Billing is proportional to the server-measured seconds: `seconds / 60 × rate`, rounded up to the nearest paisa. The call cannot exceed the configured maximum duration (60 minutes by default). Browser duration and amount fields are display-only and are never accepted by billing endpoints. When no participant joins, no amount is due. Doctor earnings are derived only from consultation and successful demo payment rows.

### Migration, test, and run

Migration `007_mock_consultation_payments.sql` creates the internal demo transaction table and extends consultation payment statuses while preserving existing consultation data. Migration `006_online_consultations.sql` is the earlier base consultation migration. Run:

```powershell
npm run db:migrate
npm test
npm run dev
```

The migration runner skips versions recorded in `schema_migrations`. If you already applied migrations through 006, it applies only 007. Create two test accounts (a patient and an administrator-verified doctor), enter `/consultations` as the doctor and enable availability, then log in as the patient, open an available doctor's profile, request an online consultation, and accept it from the doctor account. Use two browser profiles/devices to join the call. End the call and use the patient page's **Simulate successful payment**, **Simulate failed payment**, or **Cancel demo payment** buttons. Those controls are exposed only while `PAYMENT_MODE=MOCK` and `NODE_ENV` is not production. The admin consultation page shows patient, doctor, duration, amount, status, and demo transaction ID. Live camera/microphone, LiveKit webhook delivery, and real two-device connectivity require a configured LiveKit server and have not been confirmed by local unit tests.

## First administrator

Admin is not a public registration role. Create a normal account, verify its email, then set `ADMIN_EMAIL` in the local `.env` to that exact account address. Run `npm run admin:provision` and type the email when prompted. The script promotes only an existing email-verified account. Sign out and sign back in to refresh the role in your session. Keep this account protected and remove `ADMIN_EMAIL` after provisioning.

## Brevo SMTP

Use values from Brevo's SMTP settings in `.env`:

```dotenv
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-login
SMTP_PASS=your-smtp-key
SMTP_FROM_EMAIL=your-verified-sender@example.com
SMTP_FROM_NAME=HealthConnect Bharat
```

Development mode without SMTP displays the development code locally. Production mode refuses to issue verification or reset codes unless SMTP credentials are configured. A Brevo `Unauthorized IP address` response must be resolved in Brevo's access settings/support; application code cannot authorize an IP on your behalf.

## Roles and implemented workflows

- **Patient:** verified sign-up, login/reset flows, profile editing, approved doctor search, appointment requests, cancellation and rescheduling subject to the configured lead time, own medical-record and prescription views, notifications, and revocable health-worker assistance consent.
- **Doctor:** database-backed dashboard and profile, private verification documents, administrator review, weekly hours/breaks and generated slots, leave dates, appointment filters/actions, authorized patient records and private attachments, structured printable prescriptions, appointment-linked messages, notifications, affiliation requests, and account settings.
- **Hospital / health worker:** provider application and status/review flow. Hospital directory listings appear only after administrator verification. Verified health workers can request in-person appointments only for existing patients who granted limited consent; patient registration assistance is not enabled.
- **Administrator:** protected review queue, provider decisions with reasons for rejection/correction, account suspension/restoration, operational counts, and paginated/searchable audit events.
- **Public visitor:** home/about pages and approved doctor/hospital directories. Public pages do not expose private phone/email or patient data.

Appointments use transactions and row locks around the patient and selected availability slot and check overlapping active bookings. Appointment notifications are recorded in the database. Cancellation/rescheduling lead time defaults to 24 hours and can be changed with `CANCELLATION_CUTOFF_HOURS`. Weekly doctor hours generate four weeks of in-person slots in India time; existing bookings are preserved. Online consultations use the separately described LiveKit-based room workflow.

## Tests and checks

Run automated checks with:

```powershell
npm test
```

Database-backed account, SMTP, session, and concurrency checks require an isolated test database and working SMTP test configuration. Never point test runs at production data. Test execution results for the current change are reported separately with the delivery summary.

## Security and limitations

- `.env` is ignored by Git. Do not commit or share it; rotate credentials that have been exposed.
- Passwords are bcrypt-hashed; SQL uses parameters; unsafe POST requests require a session-bound CSRF token; sessions use an HTTP-only SameSite cookie and secure cookies in production.
- A doctor shown as VERIFIED has been manually approved in this application. There is no official medical-registry API integration. Admins must review supporting evidence through an approved process.
- Verification and medical attachments are size/type-checked, stored outside `public/`, and downloaded only after ownership/role checks. Files use local disk under `var/private-medical-records`; production deployments need durable private storage and backups. This is not a substitute for a compliant records platform.
- Real money payments and payouts are not configured or processed. Mock Payment simulates a demo ledger only. LiveKit video needs external LiveKit credentials and reachable webhook configuration. Affiliation decisions are made by administrators. Health-worker-assisted patient registration is not enabled.
- This is a hackathon application, not a production healthcare service. Before real patient use, complete a privacy/security review, clinician verification process, access audit, backup/recovery plan, and applicable regulatory review.

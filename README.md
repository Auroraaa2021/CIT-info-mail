# CIT Info-Mail

CIT Info-Mail is a newsletter-generation automation. It reads newsletter content and recipients from a Google Sheet, builds an HTML newsletter, lets an operator preview it, and sends either a test email or the final newsletter through SMTP.

## Sample Google Sheet

The sample sheet is available here:

[Open the CIT Info-Mail sample sheet](https://docs.google.com/spreadsheets/d/1RcafOBysmP5FtEY-MQXNDwShknmmq_DiGHq5X6LiAt4/edit?usp=sharing)

The application expects the spreadsheet to contain these tabs:

- `email` — the newsletter introduction in cell `A1`. The spreadsheet title is used as the email subject.
- `content` — newsletter entries beginning at row 2:
  - Column A: category
  - Column B: entry title
  - Column C: entry description
- `list` — recipient email addresses in column A, starting at `A1`.

Content formatting and links in Google Sheets are preserved where supported. Empty rows are ignored, and duplicate recipient addresses are removed before sending.

## How the website works

1. Open the website and paste a Google Sheets URL into **Google Sheet URL**.
2. Select **Load Newsletter**.
3. The server extracts the spreadsheet ID and reads the `email`, `content`, and `list` tabs using the Google Sheets API.
4. The website displays the generated title, entry count, category count, recipient count, and an HTML preview.
5. Use **Download HTML** to save the generated newsletter locally.
6. Enter a test address and select **Send Test Email**. The test subject is prefixed with `[TEST]`.
7. When the preview is correct, select **Send Newsletter**. The server reloads the sheet, sends the newsletter to the addresses in the `list` tab as BCC recipients, and uses the configured SMTP account as the visible recipient.

The browser does not store the recipient list. The current sheet URL is kept in the server session for the active workflow.

## Google Sheets access

The server authenticates with a Google service account and requests read-only Google Sheets access. The spreadsheet must be shared with the service-account email:

```text
cit-infomail-reader@cit-info-mail.iam.gserviceaccount.com
```

In Google Sheets:

1. Open the sample sheet or the sheet you want to use.
2. Click **Share**.
3. Add `cit-infomail-reader@cit-info-mail.iam.gserviceaccount.com`.
4. Set the permission to **Viewer**.
5. Click **Send** or **Share**.

If the sheet is not shared with this address, loading the newsletter will fail with a Google Sheets permission error. Do not make the sheet public; sharing it directly with the read-only service account is the preferred option.

The service-account JSON file must be available on the server that runs this application. The current implementation references the local path configured in `server.js` (`getGoogleSheetsClient`). Keep the JSON credentials private and never commit them to Git. JSON files are ignored by `.gitignore` by default.

## Configuration

Create a `.env` file in the project root with the SMTP and session settings required by the server:

```env
PORT=3000
SESSION_SECRET=replace-with-a-long-random-secret

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=your-sender@example.com
SMTP_EMAIL=your-visible-account@example.com
```

`SMTP_EMAIL` is used as the visible `To` recipient while the newsletter addresses are sent as BCC recipients. This avoids exposing recipient addresses to one another.

## Run locally

Requirements:

- Node.js 18 or newer
- A Google service-account JSON key with access to Google Sheets
- An SMTP account that can send the newsletter

Install dependencies and start the server:

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

## API endpoints

- `POST /api/load` — loads and renders a newsletter from `{ "sheetUrl": "..." }`.
- `POST /api/send-test` — sends a test message from `{ "sheetUrl": "...", "testAddress": "..." }`.
- `POST /api/send` — reloads the sheet and sends the final newsletter from `{ "sheetUrl": "..." }`.

## Project structure

- `server.js` — Express server, Google Sheets reader, newsletter HTML generator, SMTP mailer, and API routes.
- `public/index.html` — browser interface for loading, previewing, downloading, and sending newsletters.
- `package.json` — application scripts and dependencies.

## Sending checklist

- Confirm the spreadsheet is shared with the service account as **Viewer**.
- Check the `email`, `content`, and `list` tab names and column layout.
- Load the newsletter and review the generated preview.
- Send a test email first.
- Confirm the final recipient list is correct.
- Send the final newsletter only after the test looks correct.

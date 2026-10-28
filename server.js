import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import { google } from "googleapis";
import nodemailer from "nodemailer";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "cit-info-mail-development-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: "lax"
    }
  })
);

app.use(express.static("public"));


// =======================================================
// GOOGLE AUTH
// =======================================================

function getGoogleSheetsClient() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!keyFile) {
    throw new Error(
      "Google credentials are not configured. Set GOOGLE_APPLICATION_CREDENTIALS to the path of your service-account JSON file."
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly"
    ]
  });

  return google.sheets({
    version: "v4",
    auth
  });
}


// =======================================================
// UTILITIES
// =======================================================

function escapeHtml(text) {
  if (text === null || text === undefined) return "";

  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function escapeHtmlAttribute(text) {
  if (text === null || text === undefined) return "";

  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


function autoLinkText(text) {
  if (!text) return "";

  // Emails
  text = text.replace(
    /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi,
    '<a href="mailto:$1">$1</a>'
  );

  // URLs
  text = text.replace(
    /\b(https?:\/\/[^\s<]+)/gi,
    function (match) {
      let url = match;
      let trailing = "";

      while (/[.,;:!?)\]]$/.test(url)) {
        trailing = url.slice(-1) + trailing;
        url = url.slice(0, -1);
      }

      return (
        `<a href="${escapeHtmlAttribute(url)}" target="_blank">` +
        `${url}</a>${trailing}`
      );
    }
  );

  return text;
}


function spreadsheetIdFromUrl(input) {
  if (!input) {
    throw new Error("Google Sheet URL is missing.");
  }

  // Allow directly entering spreadsheet ID too
  if (!input.includes("/")) {
    return input.trim();
  }

  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);

  if (!match) {
    throw new Error("Invalid Google Sheets URL.");
  }

  return match[1];
}


function getCellText(cell) {
  if (!cell) return "";

  if (cell.formattedValue !== undefined) {
    return String(cell.formattedValue);
  }

  const value = cell.effectiveValue || {};

  if (value.stringValue !== undefined) return value.stringValue;
  if (value.numberValue !== undefined) return String(value.numberValue);
  if (value.boolValue !== undefined) return String(value.boolValue);

  return "";
}


// =======================================================
// GOOGLE SHEETS RICH TEXT -> HTML
// =======================================================

function mergeTextFormat(base = {}, run = {}) {
  return {
    bold:
      run.bold !== undefined
        ? run.bold
        : base.bold,

    italic:
      run.italic !== undefined
        ? run.italic
        : base.italic,

    underline:
      run.underline !== undefined
        ? run.underline
        : base.underline,

    strikethrough:
      run.strikethrough !== undefined
        ? run.strikethrough
        : base.strikethrough,

    foregroundColorStyle:
      run.foregroundColorStyle ||
      base.foregroundColorStyle,

    link:
      run.link ||
      base.link
  };
}


function colorStyleToCss(style) {
  if (!style) return null;

  const rgb = style.rgbColor;

  if (!rgb) return null;

  const r = Math.round((rgb.red || 0) * 255);
  const g = Math.round((rgb.green || 0) * 255);
  const b = Math.round((rgb.blue || 0) * 255);

  return `rgb(${r},${g},${b})`;
}


function styleText(text, style) {
  let result = escapeHtml(text);

  // Preserve line breaks
  result = result.replace(/\n/g, "<br>");

  const explicitLink = style?.link?.uri;

  if (explicitLink) {
    result =
      `<a href="${escapeHtmlAttribute(explicitLink)}" target="_blank">` +
      result +
      "</a>";
  } else {
    result = autoLinkText(result);
  }

  if (style?.bold) {
    result = `<strong>${result}</strong>`;
  }

  if (style?.italic) {
    result = `<em>${result}</em>`;
  }

  if (style?.underline) {
    result = `<u>${result}</u>`;
  }

  if (style?.strikethrough) {
    result = `<s>${result}</s>`;
  }

  const color = colorStyleToCss(style?.foregroundColorStyle);

  if (color) {
    result =
      `<span style="color:${color};">` +
      result +
      "</span>";
  }

  return result;
}


function richCellToHtml(cell) {
  if (!cell) return "";

  const text = getCellText(cell);

  if (!text) return "";

  const baseFormat =
    cell.effectiveFormat?.textFormat || {};

  const runs = cell.textFormatRuns || [];

  // No rich-text runs
  if (runs.length === 0) {
    let style = baseFormat;

    // Cell-level hyperlink
    if (cell.hyperlink && !style.link) {
      style = {
        ...style,
        link: {
          uri: cell.hyperlink
        }
      };
    }

    return styleText(text, style);
  }

  let html = "";

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];

    const start = run.startIndex || 0;

    const end =
      i + 1 < runs.length
        ? runs[i + 1].startIndex
        : text.length;

    const runText = text.slice(start, end);

    const style = mergeTextFormat(
      baseFormat,
      run.format || {}
    );

    html += styleText(runText, style);
  }

  return html;
}


// =======================================================
// READ ONE RANGE INCLUDING FORMATTING
// =======================================================

async function readSheetRange(spreadsheetId, range) {
  const sheets = getGoogleSheetsClient();

  const response = await sheets.spreadsheets.get({
    spreadsheetId,

    ranges: [range],

    includeGridData: true,

    fields:
      "properties.title," +
      "sheets(properties(title)," +
      "data(startRow,startColumn,rowData(values(" +
      "formattedValue,effectiveValue,hyperlink," +
      "effectiveFormat(textFormat)," +
      "textFormatRuns))))"
  });

  return response.data;
}


// =======================================================
// EXTRACT CELLS
// =======================================================

function extractRows(response) {
  if (!response.sheets?.length) {
    return [];
  }

  const data = response.sheets[0].data?.[0];

  if (!data) {
    return [];
  }

  return (data.rowData || []).map(
    row => row.values || []
  );
}


// =======================================================
// LOAD NEWSLETTER FROM GOOGLE SHEET
// =======================================================

async function loadNewsletter(sheetUrl) {
  const spreadsheetId =
    spreadsheetIdFromUrl(sheetUrl);

  // Retrieve three tabs
  const [
    emailResponse,
    contentResponse,
    listResponse
  ] = await Promise.all([
    readSheetRange(
      spreadsheetId,
      "email!A1"
    ),

    readSheetRange(
      spreadsheetId,
      "content!A2:C"
    ),

    readSheetRange(
      spreadsheetId,
      "list!A1:A"
    )
  ]);

  const emailTitle =
    emailResponse.properties?.title ||
    "CIT Info-Mail";

  // =========================
  // INTRO
  // =========================

  const emailRows =
    extractRows(emailResponse);

  const introCell =
    emailRows?.[0]?.[0];

  const introHtml =
    richCellToHtml(introCell);


  // =========================
  // CONTENT
  // =========================

  const contentRows =
    extractRows(contentResponse);

  const grouped = {};
  const categoryOrder = [];

  contentRows.forEach((row, index) => {

    const category =
      getCellText(row[0]).trim();

    const title =
      getCellText(row[1]).trim();

    const descriptionCell =
      row[2];

    const descriptionText =
      getCellText(descriptionCell).trim();

    if (
      !category &&
      !title &&
      !descriptionText
    ) {
      return;
    }

    if (!category) {
      return;
    }

    if (!grouped[category]) {
      grouped[category] = [];
      categoryOrder.push(category);
    }

    grouped[category].push({
      title,
      descriptionHtml:
        richCellToHtml(descriptionCell),
      id: `entry-${index}`
    });
  });


  // =========================
  // RECIPIENTS
  // =========================

  const listRows =
    extractRows(listResponse);

  const recipients =
    listRows
      .map(row =>
        getCellText(row[0]).trim()
      )
      .filter(Boolean);


  // Remove duplicates
  const uniqueRecipients =
    [...new Set(recipients)];


  // =========================
  // BUILD HTML
  // =========================

  const html =
    buildInfoMailHtml({
      emailTitle,
      introHtml,
      grouped,
      categoryOrder
    });


  return {
    spreadsheetId,
    emailTitle,
    html,
    recipients: uniqueRecipients,
    recipientCount:
      uniqueRecipients.length,
    categoryCount:
      categoryOrder.length,
    entryCount:
      categoryOrder.reduce(
        (sum, category) =>
          sum + grouped[category].length,
        0
      )
  };
}


// =======================================================
// BUILD EMAIL HTML
// =======================================================

function buildInfoMailHtml({
  emailTitle,
  introHtml,
  grouped,
  categoryOrder
}) {

  let html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
</head>

<body style="
  margin:0;
  padding:20px;
  background:#ffffff;
">

<div style="
  font-family:Arial, Helvetica, sans-serif;
  font-size:14px;
  line-height:1.15;
  color:#222222;
  max-width:1300px;
  margin:0 auto;
">

  <div style="
    text-align:center;
    margin-bottom:28px;
  ">
    <span style="
      background-color:#d9d9d9;
      font-weight:bold;
      font-size:14px;
    ">
      ${escapeHtml(emailTitle)}
    </span>
  </div>

  <div style="
    margin-bottom:30px;
  ">
    ${introHtml}
  </div>
`;


  // =====================================================
  // CONTENT OVERVIEW
  // =====================================================

  html += `
  <div
    id="content-overview"
    style="margin-bottom:30px;"
  >

    <div style="
      font-weight:bold;
      margin-bottom:16px;
    ">
      Content
    </div>
`;


  categoryOrder.forEach(category => {

    html += `
    <div style="
      font-weight:bold;
      text-decoration:underline;
      margin-top:12px;
      margin-bottom:8px;
    ">
      ${escapeHtml(category)}
    </div>
    `;


    grouped[category].forEach(entry => {

      html += `
      <div style="
        margin-left:56px;
        margin-bottom:8px;
      ">
        <a
          href="#${entry.id}"
          style="color:#0563c1;"
        >
          ${escapeHtml(entry.title)}
        </a>
      </div>
      `;
    });
  });


  html += `
  </div>
  `;


  // =====================================================
  // CATEGORIES + ENTRIES
  // =====================================================

  categoryOrder.forEach(category => {

    html += `
    <div style="
      background-color:#d9d9d9;
      text-align:center;
      font-size:18px;
      font-weight:bold;
      padding:2px 8px;
      margin-top:20px;
      margin-bottom:16px;
    ">
      ${escapeHtml(category)}
    </div>
    `;


    grouped[category].forEach(entry => {

      html += `
      <div
        id="${entry.id}"
        style="
          margin:0 16px 30px 16px;
        "
      >

        <div style="
          color:#00205b;
          font-size:19px;
          font-weight:bold;
          margin-bottom:10px;
        ">
          ${escapeHtml(entry.title)}
        </div>

        <div style="
          font-size:14px;
          line-height:1.15;
        ">
          ${entry.descriptionHtml}
        </div>

      </div>
      `;
    });


    html += `
    <div style="
      margin:20px 16px 25px 16px;
      font-size:14px;
    ">
      <a
        href="#content-overview"
        style="color:#0563c1;"
      >
        Back to the content overview
      </a>
    </div>
    `;
  });


  html += `
</div>
</body>
</html>
`;

  return html;
}


// =======================================================
// API: LOAD / PREVIEW
// =======================================================

app.post(
  "/api/load",
  async (req, res) => {

    try {

      const { sheetUrl } =
        req.body;

      const newsletter =
        await loadNewsletter(sheetUrl);

      // Store source URL in session.
      // We DON'T store all recipient data
      // in browser local storage.
      req.session.sheetUrl =
        sheetUrl;

      res.json({
        title:
          newsletter.emailTitle,

        html:
          newsletter.html,

        recipientCount:
          newsletter.recipientCount,

        categoryCount:
          newsletter.categoryCount,

        entryCount:
          newsletter.entryCount
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          error.message ||
          "Could not read Google Sheet."
      });

    }
  }
);

function getMailer() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",

    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD
    }
  });
}

async function testMailer() {
  try {
    const transporter = getMailer();

    console.log("Testing TUM SMTP...");
    console.log("Host:", process.env.SMTP_HOST);
    console.log("Port:", process.env.SMTP_PORT);
    console.log("User:", process.env.SMTP_USER);
    console.log(
      "Password loaded:",
      Boolean(process.env.SMTP_PASSWORD)
    );

    await transporter.verify();

    console.log("TUM SMTP login successful.");
  } catch (error) {
    console.error("TUM SMTP test failed:");
    console.error(error);
  }
}

testMailer();

async function sendEmail({
  subject,
  html,
  recipients
}) {
  const transporter = getMailer();

  const result = await transporter.sendMail({
    from: process.env.SMTP_FROM,

    // Your own TUM address is the visible To recipient
    to: process.env.SMTP_EMAIL,

    // Newsletter recipients don't see one another
    bcc: recipients,

    subject: subject,

    html: html,

    text: "Please view this email in an HTML-compatible email client."
  });

  console.log("Email sent:", result.messageId);

  return result;
}

// =======================================================
// SEND TEST
// =======================================================
app.post("/api/send-test", async (req, res) => {
  try {
    const {
      sheetUrl,
      testAddress
    } = req.body;

    if (!sheetUrl) {
      return res.status(400).json({
        error: "Google Sheet URL is required."
      });
    }

    if (!testAddress) {
      return res.status(400).json({
        error: "Test email address is required."
      });
    }

    const newsletter = await loadNewsletter(sheetUrl);

    await sendEmail({
      subject: "[TEST] " + newsletter.emailTitle,
      html: newsletter.html,
      recipients: [testAddress]
    });

    res.json({
      success: true,
      message: `Test email sent to ${testAddress}.`
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});


// =======================================================
// SEND REAL NEWSLETTER
// =======================================================
app.post("/api/send", async (req, res) => {
  try {
    const { sheetUrl } = req.body;

    const newsletter =
      await loadNewsletter(sheetUrl);

    if (newsletter.recipients.length === 0) {
      throw new Error("Recipient list is empty.");
    }

    await sendEmail({
      subject: newsletter.emailTitle,
      html: newsletter.html,
      recipients: newsletter.recipients
    });

    res.json({
      success: true,
      recipientCount: newsletter.recipients.length
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});


// =======================================================
// START SERVER
// =======================================================

app.listen(
  PORT,
  () => {
    console.log(
      `CIT Info-Mail running at ` +
      `http://localhost:${PORT}`
    );
  }
);

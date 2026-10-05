type TaxInvoiceInput = {
  logoUrl: string;
  invoiceNumber: string;
  invoiceDate: Date;
  status: string;
  supplier: {
    name: string;
    address: string;
    gstin: string;
    email: string;
    phone: string;
  };
  payTo: {
    accountName: string;
    accountNumber: string;
    bank: string;
    ifsc: string;
    micr: string;
    branch: string;
  };
  customer: {
    name: string;
    email: string;
    gstin?: string;
    billingAddress?: string;
  };
  serviceDescription: string;
  sac: string;
  subtotalMinor: number;
  taxRateBps: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
  paymentProvider: string;
  paymentId: string;
  orderId: string;
};

export function escapeInvoiceHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function underThousand(value: number): string {
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const parts: string[] = [];
  if (value >= 100) {
    parts.push(`${ones[Math.floor(value / 100)]} hundred`);
    value %= 100;
  }
  if (value >= 20) {
    parts.push(tens[Math.floor(value / 10)]);
    value %= 10;
  }
  if (value > 0) parts.push(ones[value]);
  return parts.join(" ");
}

function indianIntegerWords(value: number) {
  if (value === 0) return "zero";
  const groups: Array<[number, string]> = [
    [10_000_000, "crore"],
    [100_000, "lakh"],
    [1_000, "thousand"],
  ];
  const parts: string[] = [];
  for (const [size, label] of groups) {
    if (value >= size) {
      const count = Math.floor(value / size);
      parts.push(`${indianIntegerWords(count)} ${label}`);
      value %= size;
    }
  }
  if (value > 0) parts.push(underThousand(value));
  return parts.join(" ");
}

export function amountInWordsInr(totalMinor: number) {
  const safeMinor = Math.max(0, Math.round(totalMinor));
  const rupees = Math.floor(safeMinor / 100);
  const paise = safeMinor % 100;
  const words = `${indianIntegerWords(rupees)} rupee${rupees === 1 ? "" : "s"}${paise ? ` and ${indianIntegerWords(paise)} paise` : ""} only`;
  return words.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function money(valueMinor: number, currency: string) {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(valueMinor / 100);
}

export function renderTaxInvoiceHtml(input: TaxInvoiceInput) {
  const currency = input.currency.toUpperCase();
  const subtotal = money(input.subtotalMinor, currency);
  const tax = money(input.taxMinor, currency);
  const total = money(input.totalMinor, currency);
  const dateParts = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "long", year: "numeric" })
    .formatToParts(input.invoiceDate);
  const datePart = (type: Intl.DateTimeFormatPartTypes) => dateParts.find((part) => part.type === type)?.value ?? "";
  const date = `${datePart("day")}, ${datePart("month")} ${datePart("year")}`;
  const customerGstin = input.customer.gstin
    ? `<p class="gstin-line"><strong>GSTIN</strong> ${escapeInvoiceHtml(input.customer.gstin)}</p>`
    : "";
  const customerBillingAddress = input.customer.billingAddress
    ? `<p class="billing-address">${escapeInvoiceHtml(input.customer.billingAddress)}</p>`
    : "";
  const amountWords = currency === "INR"
    ? amountInWordsInr(input.totalMinor)
    : `${total} only`;
  const taxPercent = input.taxRateBps / 100;
  const taxRow = input.taxRateBps > 0
    ? `<div class="total-row"><span>GST (${escapeInvoiceHtml(taxPercent)}%)</span><strong>${escapeInvoiceHtml(tax)}</strong></div>`
    : "";
  const taxNote = input.taxRateBps > 0
    ? `GST charged at ${escapeInvoiceHtml(taxPercent)}%. Reverse charge: No.`
    : "No GST was charged on this invoice.";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeInvoiceHtml(input.invoiceNumber)} tax invoice</title>
<style>
  :root{--brand:#0d776e;--brand-dark:#07524c;--ink:#172033;--text:#354052;--muted:#778196;--line:#dfe4ec;--soft:#f7f9fa;--brand-soft:#eaf7f5;--success:#147d64}
  *{box-sizing:border-box}html,body{margin:0}body{background:#eef1f5;color:var(--text);font:12px/1.5 "Segoe UI",Arial,Helvetica,sans-serif}
  .sheet{position:relative;width:210mm;min-height:297mm;margin:18px auto;background:#fff;padding:12mm 15mm 16mm;box-shadow:0 18px 55px rgba(23,32,51,.12)}
  .accent{height:2.5px;margin:-12mm -15mm 9mm;background:linear-gradient(90deg,var(--brand-dark),var(--brand) 62%,#45ddce)}
  .header{display:flex;align-items:flex-start;justify-content:space-between;gap:18mm;padding-bottom:8mm;border-bottom:1px solid var(--line)}.brand-lockup{padding-top:1mm}.logo{display:block;width:46mm;height:13mm;object-fit:contain;object-position:left center}.tagline{margin:1.8mm 0 0;color:var(--muted);font-size:7.2px;font-weight:700;letter-spacing:.13em;text-transform:uppercase}.invoice-title{min-width:68mm;text-align:right}.invoice-title h1{margin:0;color:var(--ink);font-size:22px;font-weight:800;letter-spacing:.06em;line-height:1;text-transform:uppercase}.invoice-number{margin-top:2.5mm;color:var(--brand);font-size:12px;font-weight:800;letter-spacing:.04em}.invoice-number span{margin-right:1.5mm;color:var(--muted);font-size:7px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.meta-line{display:flex;align-items:center;justify-content:flex-end;gap:3mm;margin-top:3mm;color:var(--muted);font-size:9px}.meta-line time{color:var(--text);font-weight:600}.status{border:1px solid #b8e5d8;border-radius:999px;background:#effbf7;color:var(--success);padding:.8mm 2.5mm;font-size:7px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
  .parties{display:grid;grid-template-columns:1fr 1fr;gap:5mm;margin-top:7mm}.party{min-height:39mm;padding:5mm 5.5mm;border:1px solid var(--line);border-radius:3px;background:var(--soft)}.eyebrow,.section-label{display:block;margin-bottom:2.3mm;color:var(--brand);font-size:7.5px;font-weight:800;letter-spacing:.15em;text-transform:uppercase}.party h2{margin:0 0 1.5mm;color:var(--ink);font-size:13px;line-height:1.3}.party p{margin:0;color:var(--text);white-space:pre-line}.billing-address{margin-top:1.5mm!important;color:var(--muted)!important}.gstin-line{margin-top:3mm!important}.gstin-line strong{color:var(--muted);font-size:7.5px;letter-spacing:.09em;margin-right:1.5mm}
  .items{width:100%;margin-top:7mm;border-collapse:separate;border-spacing:0;table-layout:fixed;border:1px solid var(--line);border-radius:3px;overflow:hidden}.items th{background:var(--brand-dark);color:#fff;padding:3mm 2.5mm;font-size:7.5px;font-weight:700;letter-spacing:.1em;text-align:left;text-transform:uppercase}.items td{height:18mm;padding:4mm 2.5mm;border-top:1px solid var(--line);vertical-align:middle}.items th:nth-child(1),.items td:nth-child(1){width:8%;text-align:center}.items th:nth-child(2),.items td:nth-child(2){width:52%}.items th:nth-child(3),.items td:nth-child(3){width:15%;text-align:center}.items th:nth-child(4),.items td:nth-child(4){width:9%;text-align:center}.items th:nth-child(5),.items td:nth-child(5){width:16%;text-align:right}.items tbody td:first-child{color:var(--brand);font-weight:800}.description{color:var(--ink);font-size:12px;font-weight:700}.description small{display:block;margin-top:.8mm;color:var(--muted);font-size:8.5px;font-weight:400}
  .summary-grid{display:grid;grid-template-columns:minmax(0,1fr) 70mm;gap:13mm;margin-top:7mm}.summary-copy{padding-top:1mm}.words{max-width:92mm;color:var(--ink);font-size:11.5px;font-weight:700;line-height:1.55}.note-title{margin-top:6mm}.note{max-width:92mm;margin:0;color:var(--muted);font-size:9px}.totals{border:1px solid var(--line);border-top:2px solid var(--brand);border-radius:3px;overflow:hidden}.total-row{display:flex;align-items:center;justify-content:space-between;gap:10mm;padding:2.7mm 3.5mm;border-bottom:1px solid var(--line);background:#fff}.total-row span{color:var(--muted);font-size:9.5px}.total-row strong{color:var(--ink);font-size:10.5px}.total-row.grand{border:0;background:var(--brand-soft);padding:3.7mm 3.5mm}.total-row.grand span{color:var(--brand-dark);font-size:10px;font-weight:800;text-transform:uppercase}.total-row.grand strong{color:var(--brand-dark);font-size:15px;font-weight:800}
  .bottom{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(55mm,.9fr);gap:13mm;margin-top:9mm;padding-top:7mm;border-top:1px solid var(--line)}.pay-to{padding:0}.pay-grid{display:grid;grid-template-columns:29mm 1fr;gap:1.4mm 4mm}.pay-grid span{color:var(--muted);font-size:9px}.pay-grid strong{color:var(--ink);font-size:9.5px;overflow-wrap:anywhere}.payment-ref{margin-top:4mm;padding:3mm 3.5mm;border-left:2px solid var(--brand);background:var(--soft);color:var(--muted);font-size:8.5px}.payment-ref strong{color:var(--ink)}.signatory{display:flex;min-height:40mm;flex-direction:column;align-items:center;justify-content:flex-end;text-align:center}.signature-space{flex:1;min-height:18mm}.signature-line{width:52mm;border-top:1px solid var(--ink);padding-top:1.5mm}.signatory strong{display:block;color:var(--ink);font-size:10px}.signatory p{margin:.5mm 0 0;color:var(--muted);font-size:8px}
  .footer{position:absolute;right:15mm;bottom:7mm;left:15mm;display:flex;align-items:center;justify-content:space-between;gap:8mm;border-top:1px solid var(--line);padding-top:3mm;color:var(--muted);font-size:7.5px}.footer strong{color:var(--brand);letter-spacing:.02em}.footer-contact{text-align:right}
  .actions{width:210mm;margin:0 auto 24px;text-align:right}.actions button{border:0;border-radius:6px;background:var(--brand);color:#fff;padding:10px 18px;font-weight:700;box-shadow:0 5px 14px rgba(13,119,110,.2);cursor:pointer}.actions button:hover{background:var(--brand-dark)}
  @page{size:A4;margin:0}@media(max-width:820px){.sheet{width:100%;min-height:0;margin:0;padding:24px}.accent{margin:-24px -24px 24px}.header{flex-direction:column;gap:18px}.invoice-title{text-align:left}.meta-line{justify-content:flex-start}.parties,.summary-grid,.bottom{grid-template-columns:1fr}.party{min-height:0}.footer{position:static;flex-direction:column;align-items:flex-start;margin-top:24px}.footer-contact{text-align:left}.actions{width:auto;margin:16px 24px}}
  @media print{body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}.sheet{margin:0;box-shadow:none}.actions{display:none}}
</style></head><body><main class="sheet"><div class="accent"></div>
  <header class="header"><div class="brand-lockup"><img class="logo" src="${escapeInvoiceHtml(input.logoUrl)}" alt="Vozon.ai logo"><p class="tagline">AI Voice Agents &nbsp;&middot;&nbsp; Every Call, In Every Language</p></div><div class="invoice-title"><h1>Tax Invoice</h1><div class="invoice-number"><span>Invoice no.</span>${escapeInvoiceHtml(input.invoiceNumber)}</div><div class="meta-line"><time datetime="${escapeInvoiceHtml(input.invoiceDate.toISOString())}">${escapeInvoiceHtml(date)}</time><span class="status">${escapeInvoiceHtml(input.status || "paid")}</span></div></div></header>
  <section class="parties"><article class="party"><span class="eyebrow">From</span><h2>${escapeInvoiceHtml(input.supplier.name)}</h2><p>${escapeInvoiceHtml(input.supplier.address)}</p><p class="gstin-line"><strong>GSTIN</strong> ${escapeInvoiceHtml(input.supplier.gstin)}</p></article><article class="party"><span class="eyebrow">Billed to</span><h2>${escapeInvoiceHtml(input.customer.name)}</h2><p>${escapeInvoiceHtml(input.customer.email)}</p>${customerBillingAddress}${customerGstin}</article></section>
  <table class="items"><thead><tr><th>No.</th><th>Description</th><th>HSN/SAC</th><th>Qty</th><th>Rate</th></tr></thead><tbody><tr><td>01</td><td class="description">${escapeInvoiceHtml(input.serviceDescription)}<small>Vozon.ai software service</small></td><td>${escapeInvoiceHtml(input.sac)}</td><td>1</td><td>${escapeInvoiceHtml(subtotal)}</td></tr></tbody></table>
  <section class="summary-grid"><div class="summary-copy"><span class="section-label">Amount in words</span><div class="words">${escapeInvoiceHtml(amountWords)}</div><span class="section-label note-title">Tax note</span><p class="note">${taxNote}</p></div><div class="totals"><div class="total-row"><span>Taxable value</span><strong>${escapeInvoiceHtml(subtotal)}</strong></div>${taxRow}<div class="total-row grand" aria-label="Total paid: ${escapeInvoiceHtml(total)}"><span>Grand total</span><strong>${escapeInvoiceHtml(total)}</strong></div></div></section>
  <section class="bottom"><div class="pay-to"><span class="section-label">Payment details</span><div class="pay-grid"><span>Account name</span><strong>${escapeInvoiceHtml(input.payTo.accountName)}</strong><span>Account number</span><strong>${escapeInvoiceHtml(input.payTo.accountNumber)}</strong><span>Bank</span><strong>${escapeInvoiceHtml(input.payTo.bank)}</strong><span>IFSC</span><strong>${escapeInvoiceHtml(input.payTo.ifsc)}</strong><span>Branch</span><strong>${escapeInvoiceHtml(input.payTo.branch)}</strong></div><div class="payment-ref"><strong>Payment confirmed via ${escapeInvoiceHtml(input.paymentProvider)}</strong><br>Payment ID: ${escapeInvoiceHtml(input.paymentId || "-")} &nbsp;&middot;&nbsp; Order ID: ${escapeInvoiceHtml(input.orderId || "-")}</div></div><div class="signatory"><div class="signature-space"></div><div class="signature-line"><strong>Authorised Signatory</strong><p>For ${escapeInvoiceHtml(input.supplier.name)}</p></div></div></section>
  <footer class="footer"><strong>Thank you for choosing Vozon.ai</strong><span class="footer-contact">${escapeInvoiceHtml(input.supplier.email)} &nbsp;&middot;&nbsp; ${escapeInvoiceHtml(input.supplier.phone)} &nbsp;&middot;&nbsp; vozon.ai</span></footer>
</main><div class="actions"><button type="button" onclick="window.print()">Print / Save PDF</button></div></body></html>`;
}

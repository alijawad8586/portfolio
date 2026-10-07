/**
 * Job Tracker - automatic reminders, Add Job form, auto-fill.
 * Paste into Extensions > Apps Script of the Google Sheet version of Job-Tracker.xlsx.
 */
var JOBS = 'Jobs';
var SETTINGS = 'Settings';
var LOG = 'Reminder Log';
var HEADER_ROW = 3;
var MAX_ROW = 503;
var ALERTS = ['OVERDUE', 'DUE SOON', 'FOLLOW-UP DUE'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Job Tracker')
    .addItem('Add Job', 'showAddJobForm')
    .addItem('Mark Follow-up Done (selected row)', 'markFollowUpDone')
    .addSeparator()
    .addItem('Send Reminders Now', 'sendReminders')
    .addItem('Turn On Daily Auto-Reminders', 'installTriggers')
    .addItem('Turn Off Auto-Reminders', 'removeTriggers')
    .addToUi();
}

/* ---------- helpers ---------- */
function settings_() {
  var s = SpreadsheetApp.getActive().getSheetByName(SETTINGS);
  return {
    email: String(s.getRange('C4').getValue()).trim(),
    repeatDays: Number(s.getRange('C7').getValue()) || 2
  };
}

function headerMap_(sheet) {
  var heads = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  heads.forEach(function (h, i) { map[String(h).trim()] = i; });
  return map;
}

function currentUser_() {
  return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'Unknown';
}

function safe_(v) {            // stop typed text from becoming a formula
  v = String(v == null ? '' : v).trim();
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function nextEmptyRow_(sheet, companyCol) {
  var vals = sheet.getRange(HEADER_ROW + 1, companyCol + 1, MAX_ROW - HEADER_ROW, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (vals[i][0] === '') return HEADER_ROW + 1 + i;
  throw new Error('Jobs sheet is full (' + MAX_ROW + ' rows). Archive old jobs first.');
}

/* ---------- reminders ---------- */
function sendReminders() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(JOBS);
  var cfg = settings_();
  var h = headerMap_(sheet);
  var width = sheet.getLastColumn();
  var rows = sheet.getRange(HEADER_ROW + 1, 1, MAX_ROW - HEADER_ROW, width).getDisplayValues();
  var now = new Date();
  var byPerson = {};            // email -> [job objects]
  var touched = [];             // sheet row numbers that were included

  rows.forEach(function (r, i) {
    var alert = r[h['Alert']];
    if (ALERTS.indexOf(alert) === -1) return;
    var last = r[h['Last Reminder Sent']];
    if (last) {
      var days = (now - new Date(last)) / 86400000;
      if (!isNaN(days) && days < cfg.repeatDays) return;       // too soon, avoid spam
    }
    var job = {
      id: r[h['ID']], company: r[h['Company']], title: r[h['Job Title']], status: r[h['Status']],
      alert: alert, deadline: r[h['Deadline']], follow: r[h['Next Follow-up']],
      link: r[h['Job Link']], contact: r[h['Contact Name']], contactEmail: r[h['Contact Email']]
    };
    var owner = String(r[h['Added By']]);
    var to = [];
    if (cfg.email && cfg.email.indexOf('@') > 0 && cfg.email !== 'your-email@gmail.com') to.push(cfg.email);
    if (owner.indexOf('@') > 0 && to.indexOf(owner) === -1) to.push(owner);
    to.forEach(function (e) { (byPerson[e] = byPerson[e] || []).push(job); });
    touched.push(HEADER_ROW + 1 + i);
  });

  var sent = 0;
  Object.keys(byPerson).forEach(function (email) {
    var list = byPerson[email];
    MailApp.sendEmail({
      to: email,
      subject: 'Job Tracker: ' + list.length + ' job(s) need your attention',
      htmlBody: buildEmail_(list),
      name: 'Job Tracker'
    });
    var logSheet = ss.getSheetByName(LOG);
    logSheet.appendRow([now, email, list.length, list.map(function (j) { return j.id; }).join(', ')]);
    sent++;
  });

  touched.forEach(function (row) { sheet.getRange(row, h['Last Reminder Sent'] + 1).setValue(now); });
  var msg = sent ? ('Sent ' + sent + ' reminder email(s) covering ' + touched.length + ' job(s).')
                 : 'Nothing to send (no urgent jobs, reminders sent recently, or reminder email not set in Settings C4).';
  try { ss.toast(msg, 'Job Tracker', 6); } catch (e) { /* running from trigger */ }
  return msg;
}

function buildEmail_(list) {
  var color = { 'OVERDUE': '#c00000', 'DUE SOON': '#b36b00', 'FOLLOW-UP DUE': '#b36b00' };
  var html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">' +
    '<h2 style="color:#1F3A5F">Job Tracker - action needed</h2>' +
    '<table cellpadding="8" style="border-collapse:collapse;width:100%">' +
    '<tr style="background:#1F3A5F;color:#fff"><th align="left">Company / Role</th><th align="left">Status</th><th align="left">Alert</th><th align="left">Date</th></tr>';
  list.forEach(function (j) {
    var date = j.alert === 'FOLLOW-UP DUE' ? 'Follow up since ' + j.follow : 'Deadline ' + j.deadline;
    var name = j.link ? '<a href="' + esc_(j.link) + '">' + esc_(j.company) + '</a>' : esc_(j.company);
    var extra = j.contact ? '<br><small>Contact: ' + esc_(j.contact) + (j.contactEmail ? ' (' + esc_(j.contactEmail) + ')' : '') + '</small>' : '';
    html += '<tr style="border-bottom:1px solid #ddd"><td><b>' + name + '</b><br>' + esc_(j.title) + extra + '</td>' +
      '<td>' + esc_(j.status) + '</td>' +
      '<td style="color:' + (color[j.alert] || '#222') + '"><b>' + j.alert + '</b></td>' +
      '<td>' + esc_(date) + '</td></tr>';
  });
  html += '</table><p style="color:#777;font-size:12px">After you follow up, use Job Tracker > Mark Follow-up Done in the sheet.</p></div>';
  return html;
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- triggers ---------- */
function installTriggers() {
  removeTriggers();
  ScriptApp.newTrigger('sendReminders').timeBased().everyDays(1).atHour(8).create();
  ScriptApp.newTrigger('autoFillOnEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  SpreadsheetApp.getUi().alert('Done. Reminders will be emailed every day around 8 AM. Added By / Date Added now fill automatically.');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'sendReminders' || fn === 'autoFillOnEdit') ScriptApp.deleteTrigger(t);
  });
}

/* ---------- auto-fill when anyone types a new job ---------- */
function autoFillOnEdit(e) {
  var sh = e.range.getSheet();
  if (sh.getName() !== JOBS || e.range.getRow() <= HEADER_ROW) return;
  var h = headerMap_(sh);
  var row = e.range.getRow();
  if (sh.getRange(row, h['Company'] + 1).getValue() === '') return;
  var dateCell = sh.getRange(row, h['Date Added'] + 1);
  if (dateCell.getValue() === '') dateCell.setValue(new Date());
  var byCell = sh.getRange(row, h['Added By'] + 1);
  if (byCell.getValue() === '') byCell.setValue(currentUser_());
}

/* ---------- mark follow-up done ---------- */
function markFollowUpDone() {
  var sh = SpreadsheetApp.getActive().getActiveSheet();
  var row = sh.getActiveCell().getRow();
  if (sh.getName() !== JOBS || row <= HEADER_ROW) {
    SpreadsheetApp.getUi().alert('Click a job row on the Jobs sheet first.');
    return;
  }
  var h = headerMap_(sh);
  sh.getRange(row, h['Last Follow-up'] + 1).setValue(new Date());
  sh.getRange(row, h['Last Reminder Sent'] + 1).clearContent();
  SpreadsheetApp.getActive().toast('Follow-up saved. Next follow-up date updated.', 'Job Tracker', 4);
}

/* ---------- Add Job form ---------- */
function listFrom_(col) {
  var s = SpreadsheetApp.getActive().getSheetByName(SETTINGS);
  return s.getRange(11, col, 12, 1).getValues().map(function (r) { return r[0]; }).filter(String);
}

function showAddJobForm() {
  function opts(a) { return a.map(function (x) { return '<option>' + esc_(x) + '</option>'; }).join(''); }
  var html =
    '<style>body{font-family:Arial;font-size:13px}label{display:block;margin-top:8px;font-weight:bold}' +
    'input,select,textarea{width:100%;padding:6px;box-sizing:border-box}button{margin-top:14px;padding:9px 18px;background:#0E8A7D;color:#fff;border:0;border-radius:4px;font-size:14px}</style>' +
    '<label>Company *</label><input id="company">' +
    '<label>Job Title *</label><input id="title">' +
    '<label>Location</label><input id="location">' +
    '<label>Work Type</label><select id="type"><option></option>' + opts(listFrom_(7)) + '</select>' +
    '<label>Source</label><select id="source"><option></option>' + opts(listFrom_(9)) + '</select>' +
    '<label>Job Link</label><input id="link">' +
    '<label>Salary Range</label><input id="salary">' +
    '<label>Priority</label><select id="priority">' + opts(listFrom_(5)) + '</select>' +
    '<label>Status</label><select id="status">' + opts(listFrom_(2)) + '</select>' +
    '<label>Application Deadline</label><input id="deadline" type="date">' +
    '<label>Applied Date (if already applied)</label><input id="applied" type="date">' +
    '<label>Contact Name / Email</label><input id="contact"><input id="cemail" placeholder="email">' +
    '<label>Notes</label><textarea id="notes" rows="2"></textarea>' +
    '<button onclick="save()">Save Job</button> <span id="msg"></span>' +
    '<script>function v(i){return document.getElementById(i).value}' +
    'function save(){if(!v("company")||!v("title")){document.getElementById("msg").innerText="Company and Job Title are required";return}' +
    'var d={};["company","title","location","type","source","link","salary","priority","status","deadline","applied","contact","cemail","notes"].forEach(function(k){d[k]=v(k)});' +
    'google.script.run.withSuccessHandler(function(){google.script.host.close()}).withFailureHandler(function(e){document.getElementById("msg").innerText=e.message}).addJob(d)}</script>';
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutput(html).setTitle('Add Job'));
}

function addJob(d) {
  var sh = SpreadsheetApp.getActive().getSheetByName(JOBS);
  var h = headerMap_(sh);
  var row = nextEmptyRow_(sh, h['Company']);
  function put(name, val) {
    if (val === '' || val == null) return;
    sh.getRange(row, h[name] + 1).setValue(val);
  }
  function dateVal(s) { return s ? new Date(s + 'T00:00:00') : ''; }
  put('Date Added', new Date());
  put('Added By', currentUser_());
  put('Company', safe_(d.company));
  put('Job Title', safe_(d.title));
  put('Location', safe_(d.location));
  put('Work Type', d.type);
  put('Source', d.source);
  put('Job Link', safe_(d.link));
  put('Salary Range', safe_(d.salary));
  put('Priority', d.priority);
  put('Status', d.status);
  put('Deadline', dateVal(d.deadline));
  put('Applied Date', dateVal(d.applied));
  put('Contact Name', safe_(d.contact));
  put('Contact Email', safe_(d.cemail));
  put('Notes', safe_(d.notes));
}

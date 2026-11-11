import type { PortfolioReport } from '../api/report.svelte';

// Gecko Apprenticeships — builds the A4 portfolio PDF in the browser from the portfolio-report payload. jsPDF's default
// fonts are Latin-1 only, so everything is plain text ("Yes" / "-", never a tick glyph). Nothing is computed here: the
// numbers are the API's, only formatted.

const dash = '-';

function date(iso: string | null | undefined): string {
  if (!iso) return dash;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return dash;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function hours(minutes: number | null | undefined): string {
  return minutes === null || minutes === undefined ? dash : `${(minutes / 60).toFixed(1)} h`;
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? dash : `${v}%`;
}

function text(v: string | number | null | undefined): string {
  return v === null || v === undefined || v === '' ? dash : String(v);
}

const label = (s: string) =>
  s
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());

export function portfolioPdfFilename(report: PortfolioReport): string {
  const slug =
    (report.learner.name ?? 'learner')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'learner';
  return `portfolio-${slug}-${report.generatedAt.slice(0, 10)}.pdf`;
}

export async function downloadPortfolioPdf(report: PortfolioReport): Promise<void> {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const margin = 14;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const contentW = pageW - margin * 2;
  let y = 18;

  const ensure = (needed: number) => {
    if (y + needed > pageH - 16) {
      doc.addPage();
      y = 18;
    }
  };
  const heading = (t: string) => {
    ensure(14);
    y += 4;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(22, 100, 90);
    doc.text(t, margin, y);
    y += 2;
    doc.setDrawColor(200);
    doc.line(margin, y, pageW - margin, y);
    y += 5;
    doc.setTextColor(40);
  };
  const para = (t: string, opts: { bold?: boolean; size?: number; indent?: number } = {}) => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    doc.setFontSize(opts.size ?? 9.5);
    const x = margin + (opts.indent ?? 0);
    const lines = doc.splitTextToSize(t, contentW - (opts.indent ?? 0)) as string[];
    for (const line of lines) {
      ensure(5);
      doc.text(line, x, y);
      y += 4.6;
    }
  };
  const afterTable = (gap = 2) => {
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + gap;
  };
  const tableStyle = {
    styles: { fontSize: 8.5, cellPadding: 1.6, overflow: 'linebreak' as const },
    headStyles: { fillColor: [22, 160, 133] as [number, number, number] },
    margin: { left: margin, right: margin }
  };

  // Title + learner / programme block
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(30);
  doc.text('Apprenticeship portfolio', margin, y);
  y += 8;
  const prog = report.programme;
  const e = report.enrolment;
  const tutors = report.tutors.length
    ? report.tutors.map((t) => `${text(t.name)}${t.kind === 'PROGRAMME' ? ' (programme)' : ''}`).join(', ')
    : dash;
  autoTable(doc, {
    ...tableStyle,
    startY: y,
    theme: 'plain',
    body: [
      ['Learner', `${text(report.learner.name)}${report.learner.email ? ` (${report.learner.email})` : ''}`],
      [
        'Programme',
        `${prog.title}${prog.reference ? ` [${prog.reference}]` : ''}${prog.level ? `, level ${prog.level}` : ''}${
          prog.awardingBody ? `, ${prog.awardingBody}` : ''
        }`
      ],
      ['Qualifications', prog.qualifications.map((q) => q.title).join('; ') || dash],
      ['Start / planned end', `${date(e.startDate)} to ${date(e.plannedEndDate)}`],
      ['Stage / status', `${e.stageLabel} / ${e.statusLabel}`],
      ...(e.achievedAt ? [['Achieved', date(e.achievedAt)]] : []),
      ['Tutor(s)', tutors]
    ],
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 38 } }
  });
  afterTable(0);

  // Summary
  heading('Summary');
  autoTable(doc, {
    ...tableStyle,
    startY: y,
    head: [['Measure', 'Actual', 'Expected', 'Target', 'Status']],
    body: [
      [
        'Progress',
        pct(report.progress.actualPct),
        pct(report.progress.expectedPct),
        dash,
        label(report.progress.status)
      ],
      [
        'Off-the-job hours',
        hours(report.otj.minutesDone),
        hours(report.otj.minutesExpected),
        hours(report.otj.minutesTarget),
        label(report.otj.status)
      ],
      [
        'Guided learning hours',
        hours(report.glh.doneMinutes),
        hours(report.glh.expectedMinutes),
        hours(report.glh.targetMinutes),
        dash
      ]
    ]
  });
  afterTable();

  // Units & criteria
  heading('Units and criteria');
  if (report.units.length === 0) para('No units.');
  for (const u of report.units) {
    ensure(24);
    para(
      `${u.ref ? `${u.ref}  ` : ''}${u.title}  (${pct(u.completePct)} complete${u.glh !== null ? `, ${u.glh} GLH` : ''})`,
      { bold: true }
    );
    autoTable(doc, {
      ...tableStyle,
      startY: y - 1,
      head: [['Criterion', 'Description', 'Met']],
      body: u.criteria.map((c) => [text(c.ref), c.title, c.met ? 'Yes' : dash]),
      columnStyles: { 0: { cellWidth: 24 }, 2: { cellWidth: 14 } }
    });
    afterTable(3);
  }

  // Evidence
  heading('Evidence');
  if (report.evidence.length === 0) para('No evidence.');
  else {
    autoTable(doc, {
      ...tableStyle,
      startY: y,
      head: [['Date', 'Title', 'Type', 'Status', 'Criteria', 'Files', 'Marked by / on']],
      body: report.evidence.map((ev) => [
        date(ev.createdAt),
        ev.title,
        ev.typeLabel,
        label(ev.status),
        ev.criteriaRefs.join(', ') || dash,
        ev.fileNames.join('\n') || dash,
        ev.reviewedAt ? `${text(ev.reviewedByName)}\n${date(ev.reviewedAt)}` : dash
      ]),
      styles: { ...tableStyle.styles, fontSize: 7.5 }
    });
    afterTable();
  }

  // Tasks
  heading('Tasks');
  if (report.tasks.length === 0) para('No tasks.');
  else {
    autoTable(doc, {
      ...tableStyle,
      startY: y,
      head: [['Task', 'Due', 'Status']],
      body: report.tasks.map((t) => [t.title, date(t.dueDate), `${label(t.status)}${t.overdue ? ' (overdue)' : ''}`])
    });
    afterTable();
  }

  // Progress reviews
  heading('Progress reviews');
  if (report.reviews.length === 0) para('No progress reviews.');
  report.reviews.forEach((r, i) => {
    ensure(30);
    para(`Review ${i + 1} - ${label(r.status)}`, { bold: true });
    para(`Scheduled ${date(r.scheduledDate)}   Held ${date(r.heldDate)}   Next review ${date(r.nextReviewDate)}`, {
      size: 8.5
    });
    for (const [name, value] of [
      ['Progress summary', r.progressSummary],
      ['Targets', r.targets],
      ['Tutor comment', r.tutorComment],
      ['Learner comment', r.learnerComment],
      ['Employer comment', r.employerComment]
    ] as const) {
      if (value) para(`${name}: ${value}`, { indent: 3 });
    }
    const sig = (who: string, s: { name: string | null; signedAt: string | null }) =>
      `${who}: ${s.signedAt ? `${text(s.name)}, ${date(s.signedAt)}` : 'not signed'}`;
    para(
      `Signatures - ${sig('Tutor', r.signatures.tutor)}; ${sig('Learner', r.signatures.learner)}; ${sig(
        'Employer',
        r.signatures.employer
      )}`,
      { size: 8.5, indent: 3 }
    );
    y += 3;
  });

  // Gateway + EPA
  heading('Gateway and end-point assessment');
  const g = report.gateway;
  if (g.items.length > 0) {
    autoTable(doc, {
      ...tableStyle,
      startY: y,
      head: [['Gateway item', 'Done', 'By', 'On', 'Note']],
      body: g.items.map((it) => [it.label, it.done ? 'Yes' : dash, text(it.byName), date(it.at), text(it.note)])
    });
    afterTable();
  }
  para(
    `Gateway passed: ${g.passedAt ? `${date(g.passedAt)}${g.passedByName ? ` by ${g.passedByName}` : ''}` : 'not yet'}`
  );
  para(`EPA booked: ${date(g.epaBookedDate)}`);
  para(`EPA result: ${g.epaResult ? `${label(g.epaResult)} (${date(g.epaResultDate)})` : dash}`);

  // Footer on every page
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`Generated ${date(report.generatedAt)}`, margin, pageH - 8);
    doc.text(`Page ${p} of ${total}`, pageW - margin, pageH - 8, { align: 'right' });
  }

  doc.save(portfolioPdfFilename(report));
}

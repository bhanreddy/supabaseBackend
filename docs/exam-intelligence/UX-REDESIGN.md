# Exam Intelligence visual redesign

The existing exam workspace now leads with visual analysis, using the same backend data and authorization. No dependencies were added and no application deployment or school-policy change was performed for this redesign.

- Violet/indigo gradient workspace header, illustrated icon navigation, softer layered surfaces and visible semantic colors: teal participation, amber incomplete entries, coral support, violet analytical context.
- Four interactive metric cards. Missing overall totals remain unavailable rather than being inferred from subject means.
- Subject column graphs with real means, pass rates or participation on a labelled 0–100 scale. Six cohorts per chart page, stable subject colors, precise values/sample sizes and selection-to-evidence controls.
- Participation donut with actual result-state counts and clickable legends. The displayed participation denominator remains distinct from the all-entry ring shares.
- Published-score histograms, student/class history lines with genuine gaps, two-population comparison bars, matched score-band migration matrices and quartile box plots. No fabricated trends or decorative data series.
- Detailed numerical tables remain available under Show detailed statistics; original learner investigation and support-plan workflows are retained.
- Responsive two-column metric cards on narrow screens, stacked charts, and plots fitted to their measured card width. Subject graphs become horizontal bars on phones; data tables and matrices retain deliberate horizontal scrolling. Dark theme has its own surfaces, chart labels, navigation colors and input fills. Charts do not animate, so reduced-motion preferences are respected.

## Verification

The scoped frontend suites passed 17 tests, including zero-versus-unavailable graph descriptions and chart-to-evidence drilldowns. TypeScript, feature lint and the web build passed. Exact output is in `verification/redesign-{tests,types,lint,build}.txt`.

Browser verification used the authenticated local app with real FA-1 results for class 7-A. Verified metric switching, cohort selection, pagination, expandable statistics, desktop layout, 390×844 responsive layout and dark/light contrast. The original light preference was restored and the temporary viewport override was removed. Screenshot evidence: `verification/redesign-desktop.jpg`, `redesign-mobile.jpg` and `redesign-dark.jpg`.

Regular text/accent contrasts were checked against the selected surfaces; the eight primary accent colors have at least 4.5:1 contrast against white. Native device frame rates and assistive-technology certification were not tested in this visual pass.

## Responsive spacing follow-up

The workspace now measures its actual available width after the application sidebar. Page gutters, section padding, chart columns and metric grids adapt to that space; the content can grow to 1,800 px on wide displays.

Phone layouts use a shorter gradient header, a 44 px refresh control, exam/class selectors with More filters for secondary scope, a compact workspace chooser exposing all eight views, and an expandable eligibility note. All filter values survive opening and closing disclosures. At the smallest width the page header uses Exam insights and omits its notification shortcut so the title remains readable.

Subject bars, histograms, history plots and quartile plots fit their measured card widths. The participation ring and legend share a compact row on phones. Stacked chart cards use natural height rather than vertical flex ratios. Primary controls and chart selection chips retain at least 44 px touch targets.

Browser verification covered 320, 390, 768, 1024, 1440 and 1920 px. The measured page width matched each viewport and no visible buttons exceeded its edges in the checked views. Mobile filter expansion/collapse and all eight workspace choices were exercised with real class results. See `verification/responsive-layouts.json`, `responsive-phone-{320,390}.jpg`, `responsive-tablet-{768,1024}.jpg` and `responsive-desktop-{1440,1920}.jpg`.

Final frontend validation: 19 tests passed; TypeScript, feature lint and web export passed. Logs use the `verification/responsive-` prefix. These are browser viewport checks; physical Android/iOS device performance was not measured. No backend, school-policy or deployment changes were made during the responsive refinement.

## Across-subject student comparison

Class analysis now leads with a selected-student comparison rather than the marks-by-learner list. Subjects form the horizontal axis. Four continuous, straight-segment series show class average (teal), minimum (coral dashed), maximum (gold dotted) and student marks (thick violet with larger markers). The four-series legend sits below the plot. Raw marks are the default; Percentage offers a common scale when paper maxima differ. Selecting a subject exposes all four exact display values and cohort n.

The graph uses the existing authorized Student 360 snapshot. Its class benchmarks belong to each subject's actual assessment-time cohort. Percentage benchmark values are converted to marks using that paper's recorded maximum. Zero remains a real point; unavailable, exceptional and unpublished student marks remain gaps. Lines that overlap have equal values. Connected subject categories do not imply a time trend.

The learner selector retains its selection in the existing student_id URL parameter. Search/filter/sort and paging remain available, with detailed raw records behind an explicit disclosure. The comparison always requests every subject even if a subject-detail filter is active; Student 360 uses the same complete graph while retaining its filtered detail sections.

Verified using real FA-1 / class 7-A results for a selected learner, including raw/percentage switching, cohort values, point inspection, bottom legend, mobile widths 320/390 and desktop layout. Screenshots: `verification/student-lines-mobile.jpg`, `student-lines-small-phone.jpg` and `student-lines-desktop.jpg`. Frontend validation passed 23 tests, TypeScript, feature lint and web export; see `verification/student-lines-*.txt`. Tests cover valid zero, missing results, actual paper maxima, all-subject requests, stale student-selection responses and the Student 360 detail-filter boundary. No backend, permission, policy, dependency or deployment changes were made for this view.

## Student lookup, pagination and loading

The class comparison now has an always-visible name/admission search across the complete selected exam/class cohort. Browsing defaults to 10 learners per page, with 10/25/50 choices under Filter and sort students. Previous/next controls, desktop page numbers, page totals and visible result ranges appear above and below the graph. Changing search, sorting or page size resets browsing to page one. Search is debounced; obsolete responses cannot overwrite the latest query/page. Page controls are disabled while loading and previous student graphs are hidden until the new results arrive.

Student 360 also includes a direct Find another student lookup, including when no learner is selected or a graph request failed. It searches by name/admission number after two characters, returns paginated matching names, and opens the selected learner's complete across-subject graph. Searches retain the existing trusted school/exam/class scope and ignore a previously selected student_id when listing candidates.

Student-page fetching and graph fetching have separate explicit loading panels. Failures stop the loading state and expose local retry controls. No persistent cache, new data source, schema, school settings or backend permission changes were introduced.

Verification is recorded in `verification/student-search-{tests,types,lint,build}.txt` and `student-search-checks.json`. The frontend suites cover page changes during loading, search/page reset, page-size changes, admission lookup, retry behavior, graph retries and initial Student 360 lookup. Browser control was unavailable during this follow-up, so no new browser screenshot or visual QA claim is made. Earlier screenshots describe earlier increments only.

## Student chart visual polish

The four-line comparison has a violet/teal gradient chart surface, a restrained student-area fill, a gradient student stroke, halo markers and rounded score badges. Horizontal wrapped subject labels replace the rotated labels; crowded charts use numbered axes mapped to the full subject shortcuts below. The zero baseline and exact straight-segment score geometry remain unchanged. Area shading stops at unavailable results.

A student avatar/header, marks/percentage segmented control, coloured interactive legend pills and a selected-subject focus card provide a clearer hierarchy. The focus card shows the student's score, actual cohort average/minimum/maximum, sample size and observed difference from that subject's mean. Legend controls can hide a line while retaining at least one visible series. All four are initially visible; the thick student line remains the primary visual series. Dark-theme colors and 44 px interactive targets are retained.

Frontend verification passed 31 tests, TypeScript, feature lint and the web build. The added tests exercise legend visibility and unavailable-result focus states. Logs and source hashes use the `verification/chart-polish-` prefix. Live browser access remained unavailable, so this visual refinement has no new screenshot or browser/device QA claim. No backend, dependency, permission, school setting or deployment changes were made.

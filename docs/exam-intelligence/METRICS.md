# Exam Intelligence metric contract — v1

`services/examIntelligenceModel.js` owns analytical definitions. `services/examIntelligenceService.js` resolves trusted scoped records and historical cohorts; clients display returned values. Existing component score, alternative subject, raw-total and ranking helpers are reused. The pilot adapter also serves the existing range-chart API, so enabled schools use the same definitions on both screens.

## Records and cohort

Identity is school + paper + enrollment. Each effective paper uses its section override ahead of the class default. Students are scheduled when their enrollment's inclusive start/end dates cover the paper date in the exam's academic year. Exam start is a disclosed fallback. Missing dates exclude unresolvable cohorts; overlapping enrollments and duplicate assessment identities are invalid exceptions. Current enrollment status and current student status never determine historical participation. Soft-deleted source entities are excluded, never physically repaired by analytics.

Achievement uses valid **explicitly published** assessed records. Timetable publication, completed status and locks never substitute for result publication. An unpublished exam can show entry/participation counts, but no obtained marks or achievement values are emitted by pilot detail/export APIs.

States: `assessed` (zero included), `absent`, `medical_absence`, `exempt`, `pending`, `withheld`, `invalid`, `unsubmitted`. Legacy `is_absent` is retained. Nullable `marks.analytics_result_state` adds explicit analytical annotations without guessing historical states from remarks or marks. This annotation does not change family result-publication or legacy marks-entry behavior. Historical exceptional states require authorized source correction/import; there is no new marks-entry workflow.

Component scores use `subjectObtained`, not potentially stale cached totals. Existing component-null semantics are retained; an entirely empty component row is pending. Negative/above-maximum totals and recorded above-component-maximum values are excluded as invalid. A missing/nonpositive maximum cannot support achievement.

## Denominators

- Subject participation: valid assessed scheduled entries / scheduled entries excluding explicit exemptions. Absences and medical absences remain separate. Until eligibility is confirmed this is a scheduled-roster measure, not proof of elective eligibility.
- Entry completion: assessed + absent + medical absence + exempt + withheld entries / all scheduled entries. Pending, invalid and unsubmitted do not count as completed. Entry completion is not publication or independent verification.
- Subject achievement: valid published assessed entries only. Each metric returns n. Subject pass: scores meeting that paper's configured passing marks / valid assessed records with a valid known pass rule. No 35%/40% universal pass threshold is invented.
- Overall: a complete eligible single-exam student total, using the existing `summarizeStudentMarks` obtained and maximum totals (absence contributes zero and its maximum). No available-subject percentage average. EVS/Science totals reuse the existing alternative-subject rule.
- Require explicit `eligibility_confirmed`; every required paper must be assessed or an absence permitted by the existing raw-total convention. Pending/invalid/withheld/unsubmitted/exempt-only and medical-absence sets stay incomplete. There is no recorded medical grading/waiver policy, so medical absence is not automatically converted into an overall zero or failure. Mixed assessment-time sections are incomplete. Class-scoped completeness checks the full offered paper set rather than accepting only the papers present for a transfer. Student profiles and support evidence resolve all of that student’s effective paper-date sections; each subject keeps its own cohort. This conservative exemption rule avoids inventing an overall waiver policy.
- Explicit subject weights, when configured, calculate `sum((score / maximum) × weight) / sum(weights) × 100`; all required weights must be positive. Raw obtained/maximum totals remain visible. School mean is the mean of complete eligible student totals, never a mean of class means.
- All-subject pass: complete learners meeting **every** required paper pass rule / complete learners with known required pass rules. An absence fails this complete-result pass test. Incomplete learners are separately counted.
- Distinction requires an explicit configured percentage; otherwise unavailable. Verification completion is unavailable because there is no independent verification source.

These are **single-exam paper totals**, not FA/SA/annual final-term results. Existing final-report contribution rules are unchanged and continue through `finalResultCalculationService.js`.

## Statistics and ranking

Mean, median, minimum, maximum, Q1/Q3 and standard deviation use unrounded valid inputs. Quartiles use R-7 linear interpolation at `(n−1)p`. Standard deviation is population SD (divide by n); empty populations yield null. Display rounding never determines ties, thresholds or rank. Tied high/low counts link to the complete paginated matching learner list. Borderline lists use the configured percentage-point distance; pass margin is also returned in raw marks, and the next configured grade threshold includes raw-mark/percentage-point distance. No next-grade distance is invented for unmapped grades. Grade bands come from school-scoped `grading_scales`, lower inclusive/upper exclusive, including 100 in a top band ending at 100. Gaps/overlaps produce `Unmapped`, not a guessed grade.

Ranking reuses configured competition/dense policy and the existing competition default. Group by assessment-time section and compatible required subject/weight signature; only complete eligible results qualify. Suppress group ranks below the minimum sample (default 10). Attendance-tiebreak ranks are suppressed until validated assessment-period attendance semantics exist. Individual subject records remain accessible at every cohort size.

Percentile when ranking is usable and n>1: `100 × (count below + (count tied − 1)/2) / (n−1)`. All identical scores share the same midrank percentile. The response documents suppression rather than fabricating a position.

## Comparisons and history

Scores / maximum × 100 permit comparisons of maxima such as 25 and 100. Match **student IDs**, not enrollment IDs, across dates. Return matched n, coverage of current assessed cohort, and scheduled-roster entrants/leavers. Continuing learners gaining or losing a valid published result are counted separately; returning from absence is not a roster entrant. Coverage and population counts are descriptive, not confidence. An explicit baseline section allows section-to-section and historical-year comparison; a missing/incorrect historical section is not guessed.

Subject, grade/class identity, format/schema, pass-rule ratio and policy signature must be compatible. Otherwise suppress growth and band migration while preserving descriptive statistics. Suitable normalized comparisons are always labelled `normalized_with_limitations`: equal difficulty, syllabus coverage, accommodations and historical grading equivalence are not established by available records. Baseline/current raw means and maxima, percentage means and distributions describe their own populations; observed change is the mean of paired student percentage-point differences. Improvement/decline counts, growth filters and decline signals require the current paper date to be later than the baseline paper date. Same-date section comparisons and reverse/undated comparisons retain descriptive differences with an explicit non-growth limitation.

Migration matrices use fixed analytical 20-percentage-point score bands, **not school grades**. Below minimum group n, no ranking or inferential claim is produced; paired descriptive change can remain visible with a low-sample notice.

Student history is capped to seven earlier published examinations plus the selected exam. Each subject retains assessment-time benchmarks. Incompatible historical actual values remain visible, but change/trend claims require compatibility. Three contiguous compatible assessed observations in strictly increasing paper-date order are required for a sustained increasing/decreasing trend; two observations support a change only. Cohort mean changes are descriptive and may reflect composition. No causal attendance/teacher/intervention claims are made.

## Evidence, insight and follow-up

Every summary/page/profile includes filters, publication, calculation version, a deterministic source revision hash, data-as-of time, cohort/denominator definitions, exclusions, sample threshold and limitations. Each request reads a repeatable-read snapshot. No persistent analytics cache, sensitive offline database, report store or background summary job is introduced. Marks/publication/enrollment/grade/policy edits are reflected on the next request. A previously opened screen must be refreshed; it always displays its capture time.

Rules currently implemented: invalid result review, participation below configured threshold, incomplete entry, unpublished achievement, subject support against actual pass marks, matched cohort decline above the configured magnitude with sufficient n, concentrated identical marks above the configured fraction with sufficient n, and mark timestamps after a recorded publication timestamp. Anomaly rules are neutral review signals, not accusations. Stable rule IDs/versions and evidence filters are recomputed on every request, eliminating stale stored-insight/deduplication races. High-variability, repeated failure and three-assessment direction are exposed in individual analysis; causal misconduct allegations, overdue-deadline and teacher rules are not inferred. Revision signals require an actual publication timestamp; historical revisions without timestamps cannot be reconstructed.

Support plans reuse `student_interventions`; class cohort assignment creates at most 50 individual evidence-preserving plans atomically. Concern, proposed action, owner, target/follow-up date, measurable objective, evidence snapshot and private progress-note history are retained. Follow-up must be a later dated examination. Outcome metrics match the actual student and disclose attrition, missing result pairs and incompatibility; learners who left the scheduled cohort are not treated as zero; they never claim causal effectiveness. Historical evidence does not silently change when marks change.

## Policy

`school_settings.exam_intelligence_policy` is validated JSON. Default policy:

```json
{"minimum_sample":10,"decline_pp":10,"participation_attention":90,"borderline_pp":5,"identical_fraction":0.9,"eligibility_confirmed":false}
```

Optional: `identical_fraction` (0.5–1; default 0.9), `distinction_percentage`, `required_subject_ids` (UUID array), `subject_weights` (subject UUID → positive weight), `class_policies` (class UUID → `{eligibility_confirmed,required_subject_ids,subject_weights}`). A class policy replaces the corresponding overall eligibility/weights policy. All resource references are checked against the trusted school; unknown policy fields are rejected. Confirmation is an explicit administrator responsibility, not an automatic migration default. JSON configuration reuses existing school settings, with a leadership editor under Reports & views.

## Across-subject comparison display

The selected-student line chart uses each current subject's benchmark mean/minimum/maximum and the learner's published assessed score from one Student 360 response. Raw benchmark marks equal the returned benchmark percentage multiplied by that paper's maximum / 100. The optional percentage display retains the original normalized values. Missing benchmarks or unassessed/unpublished learner results produce gaps, never zero substitutions. X-axis subjects are categorical; the connected lines make no claim about temporal growth or student ability.

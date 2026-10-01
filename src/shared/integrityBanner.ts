/**
 * WSG-ALERT-NOT-DISMISSABLE (1.1.78): which `hive:integrity` issues the repair banner shows.
 *
 * A NOTICE (nothing is paused: a rebuilt-ledger note, a screen-guard alert, ...) may be dismissed
 * by a person. The dismissal is session-local and covers THAT raising only: an issue that is
 * raised again (a new `raisedAt`, for example a new screen-guard refusal run) shows again. A
 * damaged file that pauses changes is never dismissible: it must stay in view until repaired.
 *
 * Pure; the banner component keeps the dismissed set in its own state.
 */

export interface BannerIssue {
  file: string;
  quarantine: string | null;
  error: string;
  repaired?: boolean;
  notice?: string;
  title?: string;
  details?: string;
  raisedAt?: number;
}

/** The identity a dismissal is recorded under: the issue AND its raising. */
export function issueKey(issue: BannerIssue): string {
  return `${issue.file}|${issue.quarantine ?? ''}|${issue.error}|${issue.raisedAt ?? ''}`;
}

/** May a person close this issue? Only a notice or a rebuilt-ledger note: nothing paused. */
export function isDismissible(issue: BannerIssue): boolean {
  return !!issue.notice || issue.repaired === true;
}

/** The issues still to show, given what this session dismissed. */
export function visibleIssues<T extends BannerIssue>(issues: readonly T[], dismissed: ReadonlySet<string>): T[] {
  return issues.filter((issue) => !(isDismissible(issue) && dismissed.has(issueKey(issue))));
}

import type { createTranslator } from './index.ts';

export function localizeFinalizationBlocker(message: string, t: ReturnType<typeof createTranslator>): string {
  const exact: Record<string, string> = {
    'At least one hazard must be recorded.': 'blocker.noHazards',
    'Record whether TBM results were shared with workers.': 'blocker.sharingDecision',
    'Sharing method is required when results were shared.': 'blocker.sharingMethod',
    'Sharing recipients are required when results were shared.': 'blocker.sharingRecipients'
  };
  if (exact[message]) return t(exact[message]);
  const match = /^Hazard (\d+)( \((.*)\))?(.*)$/.exec(message);
  if (!match) return message;
  const hazard = t('blocker.hazardLabel', { number: match[1], title: match[3] ? ` (${match[3]})` : '' });
  const suffixes: Record<string, string> = {
    ' has not been reviewed.': 'blocker.notReviewed', ': immediate control taken is required.': 'blocker.immediateControl',
    ': assigned person is required.': 'blocker.assignee', ': corrective-action due date/time is required.': 'blocker.dueRequired',
    ': corrective-action due date/time is invalid.': 'blocker.dueInvalid',
    ': work status must be stopped or permitted with controls.': 'blocker.workStatus',
    ': verifiedBy is required for closure.': 'blocker.verifiedBy', ': verifiedAt is required for closure.': 'blocker.verifiedAt',
    ': verifiedAt must be a valid date/time.': 'blocker.verifiedAtInvalid'
  };
  return suffixes[match[4]] ? t(suffixes[match[4]], { hazard }) : message;
}

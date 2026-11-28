// Reminders Core pushes with `session/remind` (T32, ADR-0049; ADR-0092): which types it may
// send and the text the model reads for each. Core sends the data; the wording lives in
// `prompts/` (one place per type, so a new type is one more case here).
import { randomBytes } from 'node:crypto';

import type { ReminderType } from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import { browserStateNotice } from './browser.js';
import { browserVerifyNotice } from './prompts/browser-notices.js';
import { backgroundTaskNotice } from './prompts/notices.js';

/** The reminder types `session/remind` accepts. */
export const REMIND_TYPES = [
  'backgroundTask',
  'monitorOutput',
  'browserVerify',
  'browserState',
] as const satisfies readonly ReminderType[];

export type RemindType = (typeof REMIND_TYPES)[number];

export function isRemindType(type: unknown): type is RemindType {
  return REMIND_TYPES.some((accepted) => accepted === type);
}

/**
 * The text the model reads for a reminder Core sent. A task reminder with a `key` (Core's task
 * manager) is complete as given; one without is a bare task notice.
 */
export function formatRemind(
  type: RemindType,
  source: string,
  text: string,
  keyed: boolean,
): string {
  switch (type) {
    case 'backgroundTask':
    case 'monitorOutput':
      return keyed ? text : backgroundTaskNotice(source, text);
    case 'browserVerify':
      return browserVerifyNotice(text);
    case 'browserState': {
      // B2.7.3: Core's JSON summary; page titles go inside a boundary of their own nonce.
      const notice = browserStateNotice(text, randomBytes(6).toString('hex'));
      if (notice === undefined) {
        throw new AhpError('invalidParams', 'a browserState reminder needs a browser summary', {
          details: { member: 'text' },
        });
      }
      return notice;
    }
  }
}

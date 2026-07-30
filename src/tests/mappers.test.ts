import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCalendarJson } from '../integrations/outlookLocal.js';
import {
  mapWorkItemUpdates,
  mapPullRequests,
  mapCommits,
  isValidTenant,
  toWiqlDate,
} from '../integrations/azureDevOps.js';

// ---------------------------------------------------------------------------
// parseCalendarJson - the shell-bridge output shapes that actually vary
// ---------------------------------------------------------------------------

test('parseCalendarJson: parses an array of events', () => {
  const events = parseCalendarJson(
    JSON.stringify([
      { subject: 'Standup', start: '2026-07-28T09:00:00', end: '2026-07-28T09:15:00', attendees: 5, allDay: false },
      { subject: 'Review', start: '2026-07-28T14:00:00', end: '2026-07-28T15:00:00', attendees: 2, allDay: false },
    ])
  );

  assert.equal(events.length, 2);
  assert.equal(events[0].title, 'Standup');
  assert.equal(events[0].attendees, 5);
  assert.ok(events[0].start instanceof Date);
  assert.equal(events[1].title, 'Review');
});

test('parseCalendarJson: accepts a bare object (PowerShell unwraps single items)', () => {
  const events = parseCalendarJson(
    JSON.stringify({
      subject: 'One-on-one',
      start: '2026-07-28T11:00:00',
      end: '2026-07-28T11:30:00',
      attendees: 1,
      allDay: false,
    })
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'One-on-one');
});

test('parseCalendarJson: empty and null output mean no events', () => {
  assert.deepEqual(parseCalendarJson(''), []);
  assert.deepEqual(parseCalendarJson('   \n  '), []);
  assert.deepEqual(parseCalendarJson('null'), []);
  assert.deepEqual(parseCalendarJson('[]'), []);
});

test('parseCalendarJson: drops all-day entries and untitled events get a fallback', () => {
  const events = parseCalendarJson(
    JSON.stringify([
      { subject: 'Bank Holiday', start: '2026-07-28T00:00:00', end: '2026-07-29T00:00:00', allDay: true },
      { subject: '   ', start: '2026-07-28T10:00:00', end: '2026-07-28T10:30:00', allDay: false },
    ])
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Untitled Event');
});

test('parseCalendarJson: rejects non-JSON output loudly', () => {
  assert.throws(() => parseCalendarJson('Outlook: access denied'), /non-JSON output/);
});

// ---------------------------------------------------------------------------
// mapWorkItemUpdates
// ---------------------------------------------------------------------------

const DAY_START = new Date(2026, 6, 28, 0, 0, 0);
const DAY_END = new Date(2026, 6, 29, 0, 0, 0);
const ME = 'user-me';

test('mapWorkItemUpdates: captures a state transition made by me today', () => {
  const result = mapWorkItemUpdates(
    [
      {
        revisedBy: { id: ME },
        revisedDate: new Date(2026, 6, 28, 10, 0, 0).toISOString(),
        fields: { 'System.State': { oldValue: 'New', newValue: 'Active' } },
      },
    ],
    ME,
    DAY_START,
    DAY_END
  );

  assert.ok(result);
  assert.deepEqual(result.actions, ['state_changed']);
  assert.equal(result.stateFrom, 'New');
  assert.equal(result.stateTo, 'Active');
});

test('mapWorkItemUpdates: keeps first oldValue and last newValue across the day', () => {
  const result = mapWorkItemUpdates(
    [
      {
        revisedBy: { id: ME },
        revisedDate: new Date(2026, 6, 28, 9, 0, 0).toISOString(),
        fields: { 'System.State': { oldValue: 'New', newValue: 'Active' } },
      },
      {
        revisedBy: { id: ME },
        revisedDate: new Date(2026, 6, 28, 17, 0, 0).toISOString(),
        fields: { 'System.State': { oldValue: 'Active', newValue: 'Closed' } },
      },
    ],
    ME,
    DAY_START,
    DAY_END
  );

  assert.ok(result);
  assert.equal(result.stateFrom, 'New');
  assert.equal(result.stateTo, 'Closed');
});

test('mapWorkItemUpdates: ignores other users and other days', () => {
  const otherUser = mapWorkItemUpdates(
    [
      {
        revisedBy: { id: 'someone-else' },
        revisedDate: new Date(2026, 6, 28, 10, 0, 0).toISOString(),
        fields: { 'System.State': { oldValue: 'New', newValue: 'Active' } },
      },
    ],
    ME,
    DAY_START,
    DAY_END
  );
  assert.equal(otherUser, null);

  const otherDay = mapWorkItemUpdates(
    [
      {
        revisedBy: { id: ME },
        revisedDate: new Date(2026, 6, 27, 10, 0, 0).toISOString(),
        fields: { 'System.State': { oldValue: 'New', newValue: 'Active' } },
      },
    ],
    ME,
    DAY_START,
    DAY_END
  );
  assert.equal(otherDay, null);
});

test('mapWorkItemUpdates: bookkeeping-only revisions are not activity', () => {
  // A revision that only bumps System.Rev/ChangedDate is noise, not work.
  const result = mapWorkItemUpdates(
    [
      {
        revisedBy: { id: ME },
        revisedDate: new Date(2026, 6, 28, 10, 0, 0).toISOString(),
        fields: {
          'System.Rev': { oldValue: 1, newValue: 2 },
          'System.ChangedDate': { oldValue: 'a', newValue: 'b' },
        },
      },
    ],
    ME,
    DAY_START,
    DAY_END
  );

  assert.equal(result, null);
});

test('mapWorkItemUpdates: comment and field edits are distinguished', () => {
  const result = mapWorkItemUpdates(
    [
      {
        revisedBy: { id: ME },
        revisedDate: new Date(2026, 6, 28, 12, 0, 0).toISOString(),
        fields: {
          'System.History': { newValue: 'looks good' },
          'Microsoft.VSTS.Common.Priority': { oldValue: 2, newValue: 1 },
        },
      },
    ],
    ME,
    DAY_START,
    DAY_END
  );

  assert.ok(result);
  assert.ok(result.actions.includes('commented'));
  assert.ok(result.actions.includes('field_changed'));
});

test('mapWorkItemUpdates: survives malformed revision dates', () => {
  const result = mapWorkItemUpdates(
    [
      { revisedBy: { id: ME }, revisedDate: 'not-a-date', fields: { 'System.State': { newValue: 'Active' } } },
      { revisedBy: { id: ME }, fields: { 'System.State': { newValue: 'Active' } } },
    ],
    ME,
    DAY_START,
    DAY_END
  );

  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// mapPullRequests
// ---------------------------------------------------------------------------

test('mapPullRequests: reports creation and completion on the right day', () => {
  const prs = [
    {
      pullRequestId: 11,
      title: 'Add retry',
      status: 'active',
      creationDate: new Date(2026, 6, 28, 9, 0, 0).toISOString(),
      createdBy: { id: ME },
      repository: { name: 'core' },
    },
    {
      pullRequestId: 12,
      title: 'Fix null',
      status: 'completed',
      creationDate: new Date(2026, 6, 20, 9, 0, 0).toISOString(),
      closedDate: new Date(2026, 6, 28, 16, 0, 0).toISOString(),
      createdBy: { id: ME },
      repository: { name: 'core' },
    },
  ];

  const mapped = mapPullRequests(prs, ME, DAY_START, DAY_END, 'Retail');

  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].action, 'created');
  assert.equal(mapped[0].id, 11);
  assert.equal(mapped[1].action, 'completed');
  assert.equal(mapped[1].repository, 'core');
  assert.equal(mapped[1].project, 'Retail');
});

test('mapPullRequests: abandoned is distinguished from completed', () => {
  const mapped = mapPullRequests(
    [
      {
        pullRequestId: 13,
        title: 'Spike',
        status: 'abandoned',
        closedDate: new Date(2026, 6, 28, 12, 0, 0).toISOString(),
        createdBy: { id: ME },
        repository: { name: 'core' },
      },
    ],
    ME,
    DAY_START,
    DAY_END,
    'Retail'
  );

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].action, 'abandoned');
});

test("mapPullRequests: excludes other people's pull requests in creator mode", () => {
  const mapped = mapPullRequests(
    [
      {
        pullRequestId: 14,
        title: 'Someone else',
        creationDate: new Date(2026, 6, 28, 9, 0, 0).toISOString(),
        createdBy: { id: 'other' },
        repository: { name: 'core' },
      },
    ],
    ME,
    DAY_START,
    DAY_END,
    'Retail'
  );

  assert.equal(mapped.length, 0);
});

test('mapPullRequests: reviewer mode only reports PRs active on the day', () => {
  const prs = [
    {
      pullRequestId: 20,
      title: 'Active on the day',
      creationDate: new Date(2026, 6, 28, 8, 0, 0).toISOString(),
      createdBy: { id: 'other' },
      repository: { name: 'core' },
    },
    {
      pullRequestId: 21,
      title: 'Long-running, untouched today',
      creationDate: new Date(2026, 5, 1, 8, 0, 0).toISOString(),
      createdBy: { id: 'other' },
      repository: { name: 'core' },
    },
  ];

  const mapped = mapPullRequests(prs, ME, DAY_START, DAY_END, 'Retail', true);

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, 20);
  assert.equal(mapped[0].action, 'reviewing');
});

// ---------------------------------------------------------------------------
// mapCommits
// ---------------------------------------------------------------------------

test('mapCommits: uses the first line of the message', () => {
  const mapped = mapCommits(
    [{ comment: 'Fix login redirect\n\nLonger body that should not appear', commitId: 'abc123' }],
    'core',
    'Retail'
  );

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].message, 'Fix login redirect');
  assert.equal(mapped[0].repository, 'core');
  assert.equal(mapped[0].project, 'Retail');
});

test('mapCommits: falls back to a short sha when the message is empty', () => {
  const mapped = mapCommits([{ comment: '   ', commitId: 'abcdef1234567890' }], 'core', 'Retail');

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].message, 'commit abcdef12');
});

test('mapCommits: tolerates an empty list', () => {
  assert.deepEqual(mapCommits([], 'core', 'Retail'), []);
});

test('mapCommits: deduplicates a commit shared across repositories', () => {
  const seen = new Set<string>();
  const first = mapCommits([{ comment: 'Shared work', commitId: 'sha-1' }], 'repo-a', 'Retail', seen);
  const second = mapCommits([{ comment: 'Shared work', commitId: 'sha-1' }], 'repo-b', 'Retail', seen);

  assert.equal(first.length, 1);
  assert.equal(second.length, 0, 'the same commitId must not be reported twice');
});

test('mapCommits: distinct commits with identical messages are both kept', () => {
  const seen = new Set<string>();
  const out = mapCommits(
    [
      { comment: 'Bump version', commitId: 'sha-1' },
      { comment: 'Bump version', commitId: 'sha-2' },
    ],
    'repo-a',
    'Retail',
    seen
  );

  assert.equal(out.length, 2);
});

// ---------------------------------------------------------------------------
// toWiqlDate - WIQL rejects a time component on date-precision fields
// ---------------------------------------------------------------------------

test('toWiqlDate: emits local date only, with no time component', () => {
  assert.equal(toWiqlDate(new Date(2026, 6, 28, 23, 45, 0)), '2026-07-28');
  assert.equal(toWiqlDate(new Date(2026, 0, 5, 0, 30, 0)), '2026-01-05');
  assert.match(toWiqlDate(new Date(2026, 6, 28, 12, 0, 0)), /^\d{4}-\d{2}-\d{2}$/);
});

// ---------------------------------------------------------------------------
// isValidTenant - this value reaches a Windows command line, so rejecting shell
// metacharacters is a security property, not a formatting nicety.
// ---------------------------------------------------------------------------

test('isValidTenant: accepts GUIDs and domain names', () => {
  assert.equal(isValidTenant('104d4e98-5122-495d-987f-80ffd2b8276b'), true);
  assert.equal(isValidTenant('fashions-uk.com'), true);
  assert.equal(isValidTenant('contoso.onmicrosoft.com'), true);
});

test('isValidTenant: rejects shell metacharacters and separators', () => {
  for (const bad of [
    'abc & calc',
    'abc|whoami',
    'abc;rm -rf /',
    'abc$(whoami)',
    'abc`whoami`',
    'abc>out.txt',
    'abc"quoted"',
    "abc'quoted'",
    'abc def',
    '',
    '-leading-dash',
    '.leading-dot',
  ]) {
    assert.equal(isValidTenant(bad), false, `should reject: ${JSON.stringify(bad)}`);
  }
});

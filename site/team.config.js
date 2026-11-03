// Team configuration. Loaded by the dashboard and the terminal report; redeploy after editing.
// Member usernames live in team.json (gitignored); copy team.example.json to start one.
import team from './team.json' with { type: 'json' };

export default {
  phabricatorUrl: 'https://phabricator.services.mozilla.com',

  // Phabricator usernames of the people on your team.
  members: team.members,

  // Reviewer groups (project slugs) that count as "the team" when added as a reviewer,
  // e.g. 'geckoview-reviewers'. Leave empty to only track direct reviews.
  reviewerGroups: [],

  // Reviewers (users or groups) to drop from every patch, e.g. broad groups Herald adds
  // automatically. They're never shown and never count as who's next.
  ignoreReviewers: ['android-reviewers'],

  // Automation accounts whose actions don't count as activity.
  ignoreUsers: ['phab-bot', 'reviewbot'],

  // An open revision with no human activity for this many days is stale.
  staleDays: 7,
};

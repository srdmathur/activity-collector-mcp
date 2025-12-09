/**
 * Bundled OAuth credentials for easy setup
 * Users don't need to create their own OAuth apps
 *
 * IMPORTANT: Replace these with your actual OAuth app credentials
 * See README for instructions on creating OAuth apps
 */

export const BUNDLED_OAUTH_CREDENTIALS = {
  google: {
    clientId: '416209978562-ggjbmjrsiod8oum8notqskq92a1up8e1.apps.googleusercontent.com',
    clientSecret: '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',
    // Note: Redirect URIs are registered for ports 8080-8090
  },
  gitlab: {
    applicationId: '219139e7ca5fc6bb8b77f614fa75548e718d686c43817d5b7c98d794a711987c',
    secret: 'gloas-ef48ddc69957856808c611c048c4d3ef87646d4a6467b886b9b237174e6674d4',
    // Note: Redirect URIs are registered for ports 8080-8090
  },
};

/**
 * OAuth scopes required for each service
 */
export const OAUTH_SCOPES = {
  google: {
    calendar: ['https://www.googleapis.com/auth/calendar.readonly'],
  },
  gitlab: {
    api: ['read_api', 'read_user'], // Read-only access to user's data and API, plus user profile
  },
};

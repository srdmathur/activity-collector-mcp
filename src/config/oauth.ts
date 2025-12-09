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
    applicationId: 'f1a23cb3b183591e8aa258b59315bdb1de58ecaa5af6ca024c15d70ee223e49e',
    secret: 'gloas-0983f01857ece96523a6fee1e05f96d81df8bc009849e5d7e21ac2489e5a9d81',
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
    api: ['read_api'], // Read-only access to user's data and API
  },
};

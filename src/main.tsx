import { Devvit } from '@devvit/public-api';

// 1. Enable access to the Reddit API and the Redis KV Store
Devvit.configure({
  redditAPI: true,
  kvStore: true,
});

// 2. Setup the App Configuration field for the Mods
Devvit.addSettings([
  {
    type: 'string',
    name: 'automod_rule_names',
    label: 'AutoMod Rules to Intercept (comma-separated)',
    helpText: 'Exact names of the AutoMod rules Airlock should intercept (e.g., "New Account Filter, Low Karma")',
    defaultValue: 'New Account Filter',
  },
]);

// 3. The Installation Trigger: Spawn the Singleton Post
Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (event, context) => {
    try {
      // Prevent spawning multiple posts if the mod reinstalls/updates the app
      const existingPostId = await context.kvStore.get('singleton_post_id');
      if (existingPostId) {
        console.log('Singleton post already exists. Skipping creation.');
        return;
      }

      // Create the Singleton Post in the subreddit
      const currentSubreddit = await context.reddit.getCurrentSubreddit();
      const post = await context.reddit.submitPost({
        title: 'Airlock: Submission Recovery Engine',
        subredditName: currentSubreddit.name,
        // The 'preview' is what loads before the Custom UI boots up
        preview: (
          <vstack padding="medium" alignment="middle center">
            <text size="large" weight="bold">Airlock is active.</text>
            <text>If you were sent here, your draft is waiting.</text>
          </vstack>
        ),
      });

      // Lock the post so normal users cannot comment on it
      await post.lock();

      // Save this specific Post ID to the KV Store so the Interceptor knows where to send users
      await context.kvStore.put('singleton_post_id', post.id);
      console.log(`Successfully created and stored Singleton Post ID: ${post.id}`);

    } catch (error) {
      console.error('Failed to initialize Airlock Singleton post:', error);
    }
  },
});

// 4. Manual Override: Spawn Post via Mod Menu
Devvit.addMenuItem({
  label: 'Airlock: Spawn Recovery Post',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    try {
      const existingPostId = await context.kvStore.get('singleton_post_id');
      if (existingPostId) {
        context.ui.showToast("Airlock post already exists in the database.");
        return;
      }

      const currentSubreddit = await context.reddit.getCurrentSubreddit();
      const post = await context.reddit.submitPost({
        title: 'Airlock: Submission Recovery Engine',
        subredditName: currentSubreddit.name,
        preview: (
          <vstack padding="medium" alignment="middle center">
            <text size="large" weight="bold">Airlock is active.</text>
            <text>If you were sent here, your draft is waiting.</text>
          </vstack>
        ),
      });

      await post.lock();
      await context.kvStore.put('singleton_post_id', post.id);
      
      context.ui.showToast(`Success! Spawned Airlock Post: ${post.id}`);
    } catch (error) {
      console.error(error);
      context.ui.showToast("Failed to spawn post. Check logs.");
    }
  },
});

export default Devvit;
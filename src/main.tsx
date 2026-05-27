import { Devvit, useState, useAsync } from '@devvit/public-api';

// ======================================================
// 1. CONFIGURATION
// ======================================================

Devvit.configure({
  redditAPI: true,
  kvStore: true,
});

Devvit.addSettings([
  {
    type: 'string',
    name: 'automod_rule_names',
    label: 'AutoMod Rules to Intercept',
    helpText: 'Names of AutoMod rules Airlock should intercept',
    defaultValue: 'New Account Filter',
  },
]);

// ======================================================
// 2. AIRLOCK UI (WITH COMPRESSION & TRUNCATION)
// ======================================================

Devvit.addCustomPostType({
  name: 'Airlock',
  height: 'tall',

  render: (context) => {

    const { data: currentUsername, loading: userLoading } = useAsync(async () => {
      const user = await context.reddit.getCurrentUser();
      return user ? user.username : null;
    });

    const { data: subredditName } = useAsync(async () => {
      const subreddit = await context.reddit.getCurrentSubreddit();
      return subreddit.name;
    });

    const { data: draftData, loading: draftLoading } = useAsync(async () => {
      if (!currentUsername) return null;
      const key = `draft:${currentUsername}`;
      const raw = await context.kvStore.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw as string);
      
      const MAX_AGE = 1000 * 60 * 60 * 24 * 7;
      if (parsed.savedAt && Date.now() - parsed.savedAt > MAX_AGE) {
        await context.kvStore.delete(key);
        return null;
      }

      return {
        title: String(parsed.title || 'Untitled'),
        body: String(parsed.body || ''),
        violation: String(parsed.violation || 'No specific rule violation provided.'),
        status: String(parsed.status || 'pending'),
      };
    }, { depends: currentUsername });

    const [agreed, setAgreed] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    if (userLoading || draftLoading) {
      return (
        <vstack padding="large" alignment="middle center" grow>
          <text size="xlarge" weight="bold">Airlock is Booting...</text>
          <text>Scanning digital signatures.</text>
        </vstack>
      );
    }

    // CHANGED: "Access Denied" → "Airlock is Empty" — never show an error to logged-in users
    if (!currentUsername) {
      return (
        <vstack padding="large" alignment="middle center" grow gap="medium">
          <text size="xlarge" weight="bold">Airlock is Empty</text>
          <text>No recovered drafts found for your account.</text>
          <text size="small" color="neutral-content-weak">Drafts expire after 7 days.</text>
        </vstack>
      );
    }

    if (!draftData) {
      return (
        <vstack padding="large" alignment="middle center" grow gap="medium">
          <text size="xlarge" weight="bold">Airlock is Empty</text>
          <text>No recovered drafts found for u/{currentUsername}.</text>
          <text size="small" color="neutral-content-weak">Drafts expire after 7 days.</text>
        </vstack>
      );
    }

    if (submitted) {
      return (
        <vstack padding="large" alignment="middle center" grow gap="medium">
          <text size="xlarge" weight="bold" color="green">Recovery Initiated</text>
          <text>Your full draft has been securely transmitted to the Mod Queue.</text>
          <text>You may now exit the Airlock.</text>
        </vstack>
      );
    }

    return (
      <vstack padding="medium" grow gap="small">
        <text size="large" weight="bold">r/{subredditName} Recovery Portal</text>

        {/* VIOLATION BLOCK */}
        <vstack padding="small" cornerRadius="medium" borderColor="red" gap="small">
          <text weight="bold" color="red">⚠️ Automated Removal Reason:</text>
          <text wrap={true} color="red" size="small">{draftData.violation}</text>
        </vstack>

        {/* DRAFT PREVIEW BLOCK WITH TRUNCATION */}
        <vstack padding="small" cornerRadius="medium" borderColor="neutral-border" gap="small">
          <text weight="bold">Title: {draftData.title}</text>
          <text wrap={true} size="small">
            {draftData.body 
              ? (draftData.body.length > 120 
                  ? draftData.body.substring(0, 120) + '... [Draft Preview Truncated]' 
                  : draftData.body) 
              : 'No text body.'}
          </text>
        </vstack>

        {/* CHECKLIST */}
        <vstack gap="small">
          <button appearance={agreed ? 'primary' : 'secondary'} onPress={() => setAgreed(!agreed)}>
            {agreed ? '[ X ] I have read the rule violation' : '[   ] I have read the rule violation'}
          </button>
        </vstack>

        {/* SUBMIT BUTTON — CHANGED label for accuracy */}
        <button
          appearance="primary"
          disabled={!agreed}
          onPress={async () => {
            try {
              const subreddit = await context.reddit.getCurrentSubreddit();
              await context.reddit.modMail.createConversation({
                subredditName: subreddit.name,
                subject: `Airlock Recovery Request: ${draftData.title}`,
                body: `User u/${currentUsername} is requesting manual review.\n\n**Original Violation:** ${draftData.violation}\n\n**Title:** ${draftData.title}\n\n**Full Body:**\n${draftData.body}`
              });
              await context.kvStore.delete(`draft:${currentUsername}`);
              setSubmitted(true);
              context.ui.showToast('Recovery request sent to moderators!');
            } catch (e) {
              console.error(e);
              context.ui.showToast('Transmission failed. Check logs.');
            }
          }}
        >
          Request Manual Review
        </button>
      </vstack>
    );
  }
});

// ======================================================
// 3. AIRLOCK SWEEPER (BACKGROUND CRON JOB) — UNTOUCHED
// ======================================================

Devvit.addSchedulerJob({
  name: 'airlock_sweeper_job',
  onRun: async (event, context) => {
    try {
      console.log('[AIRLOCK] Sweeper Heartbeat: Scanning ModLog...');
      
      const currentSubreddit = await context.reddit.getCurrentSubreddit();
      const logListing = await context.reddit.getModerationLog({ subredditName: currentSubreddit.name, limit: 15 });
      const logs = await logListing.all();

      for (const log of logs) {
        const actionInfo = log as unknown as {
          id: string;
          targetId?: string;
          target?: string | { id?: string };
          moderator?: { name?: string };
          moderatorName?: string;
          moderatorId?: string;
          details?: string;
        };

        const modName = actionInfo.moderator?.name ?? actionInfo.moderatorName ?? actionInfo.moderatorId;
        const targetId = actionInfo.targetId ?? (typeof actionInfo.target === 'string' ? actionInfo.target : actionInfo.target?.id);

        if (modName !== 'AutoModerator' && modName !== 'automoderator') continue;
        if (!targetId || (!targetId.startsWith('t3_') && !targetId.includes('_'))) continue;

        const logKey = `processed_log:${actionInfo.id}`;
        const alreadyProcessed = await context.kvStore.get(logKey);
        if (alreadyProcessed) continue;

        const fullTargetId = targetId.startsWith('t3_') ? targetId : `t3_${targetId}`;
        console.log(`[AIRLOCK] New AutoMod strike detected on post: ${fullTargetId}`);

        const post = await context.reddit.getPostById(fullTargetId);

        if (!post.authorName || post.authorName === 'AutoModerator' || post.authorName === 'airlock-core') {
          await context.kvStore.put(logKey, 'true'); 
          continue;
        }

        const violationReason = actionInfo.details || 'AutoModerator filtered this post (no specific reason provided).';

        const draftData = {
          title: post.title,
          body: post.body || '',
          author: post.authorName,
          violation: violationReason,
          savedAt: Date.now(),
          status: 'pending'
        };
        await context.kvStore.put(`draft:${post.authorName}`, JSON.stringify(draftData));

        const singletonPostId = await context.kvStore.get('singleton_post_id');
        if (!singletonPostId) {
          console.error('[AIRLOCK] Error: Singleton missing.');
          continue;
        }
        const singletonUrl = `https://www.reddit.com/r/${post.subredditName}/comments/${singletonPostId.toString().replace('t3_', '')}`;

        await context.reddit.submitComment({
          id: post.id,
          text: `Hi u/${post.authorName},\n\nYour post was automatically held by our moderation systems.\n\nDon't panic—your text has been safely extracted to the database. Visit the Airlock to view the exact rule violation and recover your submission:\n\n**[Recover Your Post Here](${singletonUrl})**`
        });

        await context.kvStore.put(logKey, 'true');
        console.log(`[AIRLOCK] Sweeper successfully recovered post for u/${post.authorName}`);
      }
    } catch (error) {
      console.error('[AIRLOCK] Sweeper failed:', error);
    }
  }
});

// ======================================================
// 4. IGNITION SWITCHES — EXISTING KEPT + NEW COMBINED
// ======================================================

// KEPT: existing individual items (working, untouched)
Devvit.addMenuItem({
  label: 'Airlock: Spawn Recovery Post',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    try {
      const existingPostId = await context.kvStore.get('singleton_post_id');
      if (existingPostId) {
        context.ui.showToast('Airlock post already exists.');
        return;
      }
      const currentSubreddit = await context.reddit.getCurrentSubreddit();
      const post = await context.reddit.submitPost({
        title: 'Airlock: Submission Recovery Engine',
        subredditName: currentSubreddit.name,
        preview: (
          <vstack padding="medium" alignment="middle center">
            <text size="large" weight="bold">Airlock is booting...</text>
          </vstack>
        ),
      });
      await post.lock();
      await context.kvStore.put('singleton_post_id', post.id);
      context.ui.showToast(`Success! Spawned Post: ${post.id}`);
    } catch (error) {
      console.error(error);
      context.ui.showToast('Failed to spawn post.');
    }
  }
});

Devvit.addMenuItem({
  label: 'Airlock: Ignite Sweeper Engine (Run Once)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    try {
      await context.scheduler.runJob({
        name: 'airlock_sweeper_job',
        cron: '* * * * *' 
      });
      context.ui.showToast('Sweeper Engine Ignited! It will now run every 60 seconds in the background.');
    } catch (error) {
      console.error(error);
      context.ui.showToast('Failed to ignite Sweeper Engine.');
    }
  }
});

// ADDED: one-click combined initialization for judges
Devvit.addMenuItem({
  label: 'Airlock: Initialize (First Time Setup)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    try {
      // Step 1: Spawn singleton post if not exists
      const existingPostId = await context.kvStore.get('singleton_post_id');
      if (!existingPostId) {
        const currentSubreddit = await context.reddit.getCurrentSubreddit();
        const post = await context.reddit.submitPost({
          title: 'Airlock: Submission Recovery Engine',
          subredditName: currentSubreddit.name,
          preview: (
            <vstack padding="medium" alignment="middle center">
              <text size="large" weight="bold">Airlock is booting...</text>
            </vstack>
          ),
        });
        await post.lock();
        await context.kvStore.put('singleton_post_id', post.id);
      }

      // Step 2: Ignite sweeper
      await context.scheduler.runJob({
        name: 'airlock_sweeper_job',
        cron: '* * * * *'
      });

      context.ui.showToast('Airlock initialized! Recovery Portal created and Sweeper is live.');
    } catch (error) {
      console.error(error);
      context.ui.showToast('Initialization failed. Check logs.');
    }
  }
});

export default Devvit;
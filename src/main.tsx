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
// 2. AIRLOCK UI
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

      // OPTIONAL: Draft Expiry Protection (7 Days)
      const MAX_AGE = 1000 * 60 * 60 * 24 * 7;

      if (
        parsed.savedAt &&
        Date.now() - parsed.savedAt > MAX_AGE
      ) {
        await context.kvStore.delete(key);
        return null;
      }

      return {
        title: String(parsed.title || 'Untitled'),
        body: String(parsed.body || ''),
        violation: String(
          parsed.violation ||
          'No specific rule violation provided.'
        ),
        status: String(parsed.status || 'pending'),
      };

    }, { depends: currentUsername });

    const [agreed, setAgreed] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    // ======================================================
    // LOADING STATE
    // ======================================================

    if (userLoading || draftLoading) {
      return (
        <vstack padding="large" alignment="middle center" grow>
          <text size="xlarge" weight="bold">
            Airlock is Booting...
          </text>

          <text>
            Scanning digital signatures.
          </text>
        </vstack>
      );
    }

    // ======================================================
    // AUTH CHECK
    // ======================================================

    if (!currentUsername) {
      return (
        <vstack padding="large" alignment="middle center" grow>
          <text size="xlarge" weight="bold" color="red">
            Access Denied
          </text>

          <text>
            You must be logged in to access the Airlock.
          </text>
        </vstack>
      );
    }

    // ======================================================
    // EMPTY STATE
    // ======================================================

    if (!draftData) {
      return (
        <vstack padding="large" alignment="middle center" grow gap="medium">

          <text size="xlarge" weight="bold">
            Airlock is Empty
          </text>

          <text>
            No recovered drafts found for u/{currentUsername}.
          </text>

        </vstack>
      );
    }

    // ======================================================
    // SUCCESS STATE
    // ======================================================

    if (submitted) {
      return (
        <vstack padding="large" alignment="middle center" grow gap="medium">

          <text size="xlarge" weight="bold" color="green">
            Recovery Initiated
          </text>

          <text>
            Your draft has been securely transmitted to the Mod Queue.
          </text>

          <text>
            You may now exit the Airlock.
          </text>

        </vstack>
      );
    }

    // ======================================================
    // MAIN UI
    // ======================================================

    return (
      <vstack padding="large" grow gap="medium">

        <text size="xlarge" weight="bold">
          r/{subredditName} Recovery Portal
        </text>

        <text>
          Welcome, u/{currentUsername}. Review your recovered draft and the exact rule violation below.
        </text>

        {/* VIOLATION BLOCK */}

        <vstack
          padding="medium"
          cornerRadius="medium"
          borderColor="red"
          gap="small"
        >

          <text weight="bold" color="red">
            ⚠️ Automated Removal Reason:
          </text>

          <text wrap={true} color="red">
            {draftData.violation}
          </text>

        </vstack>

        {/* DRAFT BLOCK */}

        <vstack
          padding="medium"
          cornerRadius="medium"
          borderColor="neutral-border"
          gap="small"
        >

          <text weight="bold">
            Title: {draftData.title}
          </text>

          <text wrap={true}>
            {draftData.body || 'No text body.'}
          </text>

        </vstack>

        {/* CHECKLIST */}

        <vstack gap="small">

          <text weight="bold">
            Mandatory Clearance Checklist:
          </text>

          <button
            appearance={agreed ? 'primary' : 'secondary'}
            onPress={() => setAgreed(!agreed)}
          >

            {
              agreed
                ? '[ X ] I confirm I have read the rule violation and revised my submission'
                : '[   ] I confirm I have read the rule violation and revised my submission'
            }

          </button>

        </vstack>

        {/* SUBMIT BUTTON */}

        <button
          appearance="primary"
          disabled={!agreed}

          onPress={async () => {

            try {

              const subreddit =
                await context.reddit.getCurrentSubreddit();

              await context.reddit.modMail.createConversation({

                subredditName: subreddit.name,

                subject:
                  `Airlock Recovery Request: ${draftData.title}`,

                body:
                  `User u/${currentUsername} is requesting manual review after an AutoMod filter.\n\n` +
                  `**Original Violation:** ${draftData.violation}\n\n` +
                  `**Title:** ${draftData.title}\n\n` +
                  `**Body:** ${draftData.body}`

              });

              await context.kvStore.delete(
                `draft:${currentUsername}`
              );

              setSubmitted(true);

              context.ui.showToast(
                'Draft sent to Mod Queue!'
              );

            } catch (e) {

              console.error(e);

              context.ui.showToast(
                'Transmission failed. Check logs.'
              );

            }

          }}
        >
          Transmit to Mod Queue
        </button>

      </vstack>
    );
  }
});

// ======================================================
// 3. INSTALLATION TRIGGER
// ======================================================

Devvit.addTrigger({
  event: 'AppInstall',

  onEvent: async (_event, context) => {

    try {

      const existingPostId =
        await context.kvStore.get('singleton_post_id');

      if (existingPostId) return;

      const currentSubreddit =
        await context.reddit.getCurrentSubreddit();

      const post = await context.reddit.submitPost({

        title: 'Airlock: Submission Recovery Engine',

        subredditName: currentSubreddit.name,

        preview: (
          <vstack padding="medium" alignment="middle center">

            <text size="large" weight="bold">
              Airlock is booting...
            </text>

          </vstack>
        ),
      });

      await post.lock();

      await context.kvStore.put(
        'singleton_post_id',
        post.id
      );

    } catch (error) {

      console.error(
        'Failed to initialize Airlock Singleton:',
        error
      );

    }
  },
});

// ======================================================
// 4. MOD MENU: SPAWN POST
// ======================================================

Devvit.addMenuItem({

  label: 'Airlock: Spawn Recovery Post',

  location: 'subreddit',

  forUserType: 'moderator',

  onPress: async (_event, context) => {

    try {

      const existingPostId =
        await context.kvStore.get('singleton_post_id');

      if (existingPostId) {

        context.ui.showToast(
          'Airlock post already exists.'
        );

        return;
      }

      const currentSubreddit =
        await context.reddit.getCurrentSubreddit();

      const post = await context.reddit.submitPost({

        title: 'Airlock: Submission Recovery Engine',

        subredditName: currentSubreddit.name,

        preview: (
          <vstack padding="medium" alignment="middle center">

            <text size="large" weight="bold">
              Airlock is booting...
            </text>

          </vstack>
        ),
      });

      await post.lock();

      await context.kvStore.put(
        'singleton_post_id',
        post.id
      );

      context.ui.showToast(
        `Success! Spawned Post: ${post.id}`
      );

    } catch (error) {

      console.error(error);

      context.ui.showToast(
        'Failed to spawn post.'
      );

    }
  },
});

// ======================================================
// 5. DYNAMIC INTERCEPTOR ENGINE
// ======================================================

Devvit.addMenuItem({

  label: 'Airlock: Execute Recovery Protocol',

  location: 'post',

  forUserType: 'moderator',

  onPress: async (event, context) => {

    try {

      // SAFE EVENT PARSING

      const eventData = event as {
        targetId?: string;
        target?: string | { id?: string };
      };

      const postId =
        eventData.targetId ??
        (
          typeof eventData.target === 'string'
            ? eventData.target
            : eventData.target?.id
        );

      if (!postId) {

        context.ui.showToast(
          'Failed to resolve post ID.'
        );

        return;
      }

      const post =
        await context.reddit.getPostById(postId);

      if (!post.authorName) {

        context.ui.showToast(
          'Could not identify post author.'
        );

        return;
      }

      // OPTIONAL ANTI-SPAM COOLDOWN

      const cooldownKey =
        `cooldown:${post.authorName}`;

      const existingCooldown =
        await context.kvStore.get(cooldownKey);

      if (existingCooldown) {

        const lastRecoveryAt =
          Number(existingCooldown);

        const cooldownWindow = 1000 * 60;

        if (
          Date.now() - lastRecoveryAt <
          cooldownWindow
        ) {

          context.ui.showToast(
            'Recovery cooldown active.'
          );

          return;
        }
      }

      await context.kvStore.put(
        cooldownKey,
        Date.now().toString()
      );

      context.ui.showToast(
        `Intercepting draft for u/${post.authorName}...`
      );

      // ======================================================
      // DYNAMIC VIOLATION EXTRACTION
      // ======================================================

      let dynamicViolationReason =
        'AutoModerator removed this post, but the specific rule violation could not be parsed.';

      try {

        const logListing =
          await context.reddit.getModerationLog({

            subredditName: post.subredditName,
            limit: 20

          });

        const logs = await logListing.all();

        // SAFE MODERATION LOG PARSING

        const specificLog = logs.find((log) => {

          const action = log as unknown as {

            targetId?: string;

            target?: string | { id?: string };

            moderator?: { name?: string };

            moderatorName?: string;

            moderatorId?: string;

            details?: string;
          };

          const targetId =
            action.targetId ??
            (
              typeof action.target === 'string'
                ? action.target
                : action.target?.id
            );

          const moderatorName =
            action.moderator?.name ??
            action.moderatorName ??
            action.moderatorId;

          return (
            (
              targetId === post.id ||
              targetId === `t3_${post.id}`
            ) &&
            moderatorName === 'AutoModerator'
          );
        });

        if (
          specificLog &&
          specificLog.details
        ) {

          dynamicViolationReason =
            specificLog.details;
        }

      } catch (logError) {

        console.error(
          'ModLog Extraction Failed:',
          logError
        );

      }

      // ======================================================
      // SAVE DRAFT
      // ======================================================

      const draftData = {

        title: post.title,

        body: post.body || '',

        author: post.authorName,

        violation: dynamicViolationReason,

        savedAt: Date.now(),

        status: 'pending'
      };

      await context.kvStore.put(
        `draft:${post.authorName}`,
        JSON.stringify(draftData)
      );

      // ======================================================
      // FETCH AIRLOCK PORTAL
      // ======================================================

      const singletonPostId =
        await context.kvStore.get(
          'singleton_post_id'
        );

      if (!singletonPostId) {

        context.ui.showToast(
          'Error: Airlock Singleton missing.'
        );

        return;
      }

      const singletonUrl =
        `https://www.reddit.com/r/${post.subredditName}/comments/${singletonPostId.toString().replace('t3_', '')}`;

      // ======================================================
      // COMMENT-BASED RECOVERY NOTIFICATION
      // ======================================================

      await context.reddit.submitComment({

        id: post.id,

        text:
          `Hi u/${post.authorName},\n\n` +
          `Your post was temporarily held by AutoModerator.\n\n` +
          `Don't worry, your text has been saved safely in the database.\n\n` +
          `Visit the Airlock to review and recover your submission:\n\n` +
          `**[Recover Your Post Here](${singletonUrl})**`
      });

      context.ui.showToast(
        'Success! Notification comment posted.'
      );

    } catch (error) {

      console.error(error);

      context.ui.showToast(
        'Pipeline failed. Check logs.'
      );

    }
  }
});

export default Devvit;
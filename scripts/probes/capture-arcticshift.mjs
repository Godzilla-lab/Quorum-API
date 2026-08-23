/*
 * Captures live Arctic Shift responses as test fixtures.
 *
 * Fixtures are captured, never authored. A hand written fixture invented a
 * `points` field on a Hacker News comment, which made a completely broken
 * adapter pass fifteen tests, so this is not a style preference.
 *
 * Only public fields are kept. Public usernames are part of the record and stay.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArcticShiftClient } from '../../packages/sources/src/reddit-arcticshift/client.ts';

const OUT = join(import.meta.dirname, '../../packages/sources/src/reddit-arcticshift/fixtures');
const client = createArcticShiftClient();

const subs = await client.get('subreddits/search', {
  subreddit_prefix: 'running', limit: 8, fields: 'display_name,subscribers,public_description,over18',
});
writeFileSync(join(OUT, 'subreddits-search.json'), JSON.stringify({ data: subs }, null, 2) + '\n');
console.log('subreddits:', subs.length);

/*
 * The SAME window production queries with, including the settle cutoff. A
 * fixture captured with different parameters is a fixture of something we never
 * actually ask for, which is only marginally better than authoring one.
 */
const now = Math.floor(Date.now() / 1000);
const posts = await client.get('posts/search', {
  subreddit: 'running', query: 'shoes', limit: 15,
  after: now - 540 * 86400,
  before: now - 30 * 86400,
  fields: 'id,title,selftext,score,num_comments,subreddit,created_utc',
});
writeFileSync(join(OUT, 'posts-search.json'), JSON.stringify({ data: posts }, null, 2) + '\n');
console.log('posts:', posts.length);

/* Pick the most discussed thread, since comments are the point. */
const withComments = [...posts].sort((a, b) => (b.num_comments ?? 0) - (a.num_comments ?? 0))[0];
console.log('most discussed post has', withComments?.num_comments, 'comments');
if (withComments) {
  const comments = await client.get('comments/search', {
    link_id: `t3_${withComments.id}`, limit: 12, fields: 'body,score,author',
  });
  writeFileSync(join(OUT, 'comments-search.json'), JSON.stringify({ data: comments }, null, 2) + '\n');
  console.log('comments:', comments.length, 'for post', withComments.id);
}

import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = await getCollection('blog');
  return rss({
    title: 'Dhiyanesh Sidhaiyan',
    description: 'Writing on software architecture, AI systems, and engineering leadership.',
    site: context.site ?? 'https://dhiyanesh-sidhaiyan.github.io',
    items: posts
      .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
      .map((post) => ({
        title: post.data.title,
        description: post.data.description ?? '',
        pubDate: post.data.date,
        link: post.data.link ?? `/blog/${post.id}/`,
      })),
  });
}

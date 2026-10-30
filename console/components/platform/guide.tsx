import Link from 'next/link';
import { PageHeading } from '@/components/platform-ui';
import { PLATFORM_SECTIONS, PLATFORM_WORDS, pagesIn } from '@/lib/platform-map';

/** Where to look and what to read: the map of the console, printed. Static; it reads nothing. */
export function GuidePage() {
  return (
    <div className="page-stack" role="region" aria-label="Guide">
      <PageHeading
        title="Guide"
        description="Which page to open for what, and what to read once you are there. Start with Protection: it says whether Stroq is being asked about what your agents do, and lists what needs you."
      />
      <ol className="guide-start" aria-label="Start here">
        <li>
          <strong>Connect your agents.</strong> On{' '}
          <Link href="/agents/" className="inline-link">
            Agents & coverage
          </Link>
          , use Configure for each agent you use. Until an agent is connected, nothing it does is
          judged.
        </li>
        <li>
          <strong>Check the answer on Protection.</strong>{' '}
          <Link href="/" className="inline-link">
            Protection
          </Link>{' '}
          says which agents Stroq is being asked by, and what needs you.
        </li>
        <li>
          <strong>Keep Live open while you work.</strong>{' '}
          <Link href="/live/" className="inline-link">
            Live
          </Link>{' '}
          shows each decision as it is recorded, and can notify you of denied and flagged ones.
        </li>
      </ol>
      {PLATFORM_SECTIONS.map((section) => (
        <section key={section.id} className="guide-section" aria-labelledby={`guide-${section.id}`}>
          <div className="guide-section-head">
            <h2 id={`guide-${section.id}`}>{section.label}</h2>
            <p>{section.hint}</p>
          </div>
          <dl className="guide-pages">
            {pagesIn(section.id).map((page) => (
              <div key={page.href} className="guide-page">
                <dt>
                  <Link href={page.href} className="inline-link">
                    {page.label}
                  </Link>
                </dt>
                <dd>
                  <span className="guide-when">{page.when}</span>
                  <span className="guide-read">{page.read}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <section className="guide-section" aria-labelledby="guide-words">
        <div className="guide-section-head">
          <h2 id="guide-words">What the words mean</h2>
          <p>The same words are used on every page.</p>
        </div>
        <dl className="guide-pages">
          {PLATFORM_WORDS.map((entry) => (
            <div key={entry.word} className="guide-page">
              <dt>{entry.word}</dt>
              <dd>
                <span className="guide-read">{entry.meaning}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

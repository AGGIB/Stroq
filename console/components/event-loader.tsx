'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { eventById } from '@/lib/events';
import { EventView } from './event-view';
import { PageHeader } from './section';

const MAX_ID_LENGTH = 64;

export function EventLoader() {
  const id = (useSearchParams().get('id') ?? '').slice(0, MAX_ID_LENGTH);
  const detail = id === '' ? undefined : eventById(id);

  if (detail === undefined) {
    return (
      <>
        <PageHeader
          title="Event not found"
          lede="This event is not in the log, or the link is incomplete."
        />
        <p className="mt-6">
          <Link
            href="/activity/"
            className="font-medium underline underline-offset-4 decoration-hairline-strong hover:decoration-current"
          >
            Back to Activity
          </Link>
        </p>
      </>
    );
  }
  return <EventView detail={detail} />;
}

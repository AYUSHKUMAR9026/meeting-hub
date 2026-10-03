import { Badge } from '@/components/ui/badge';
import type { MeetingStatus } from '@/lib/api/client';

const labels: Record<MeetingStatus, string> = {
  awaiting_upload: 'Awaiting upload',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  processing: 'Processing',
  ready: 'Ready',
  partially_ready: 'Partially ready',
  failed: 'Failed',
};

const variants: Record<MeetingStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  awaiting_upload: 'outline',
  uploading: 'secondary',
  uploaded: 'default',
  processing: 'secondary',
  ready: 'default',
  partially_ready: 'secondary',
  failed: 'destructive',
};

export function MeetingStatusBadge({ status }: { status: MeetingStatus }) {
  return (
    <Badge variant={variants[status]} data-testid="meeting-status">
      {labels[status]}
    </Badge>
  );
}

import { useState } from 'react'
import {
  Card,
  Section,
  Stack,
  Row,
  Button,
  Input,
  SegmentedControl,
  Icon,
  IconButton,
  IconTile,
  StatusDot,
  Meta,
  MetaItem,
  Badge,
  Modal,
  Pill,
  EmptyState,
  ProgressBar,
  Skeleton,
  Textarea
} from '../components/primitives'
import './gallery.css'

type SortOption = 'recent' | 'name' | 'status'

/** Dev-only route: renders every design-system primitive against the token
 * contract so a milestone's spacing/type/container work is checkable without
 * a real screen (plan 7, stage A2). Reached via `npm run shot --
 * gallery <theme>`, never linked from normal navigation. */
export default function PrimitivesGallery(): React.JSX.Element {
  const [sort, setSort] = useState<SortOption>('recent')
  const [showModal, setShowModal] = useState(false)

  return (
    <div className="gallery-page">
      <Stack gap={48}>
        <Stack gap={8}>
          <h1 className="gallery-display">Primitives gallery</h1>
          <p className="gallery-caption">Tokens and components from plan 7, stage A2: dev only.</p>
        </Stack>

        <Section heading="Type roles">
          <Stack gap={8}>
            <div className="gallery-type-display">Display: screen title</div>
            <div className="gallery-type-title">Title: card title, section header</div>
            <div className="gallery-type-body">Body: default paragraph text</div>
            <div className="gallery-type-label">Label: buttons, tabs, form labels</div>
            <div className="gallery-type-caption">Caption: metadata, timestamps, counts</div>
            <div className="gallery-type-mono">mono: paths, branches, sha</div>
          </Stack>
        </Section>

        <Section heading="Containers" controls={<Button variant="filled">Primary action</Button>}>
          <Row gap={16} align="stretch">
            <Card level="flat" className="gallery-swatch">
              Flat
            </Card>
            <Card level="raised" className="gallery-swatch">
              Raised
            </Card>
            <Card level="outlined" className="gallery-swatch">
              Outlined
            </Card>
          </Row>
        </Section>

        <Section heading="Buttons">
          <Row gap={16}>
            <Button variant="filled" size="compact">
              Filled compact
            </Button>
            <Button variant="outlined" size="default">
              Outlined default
            </Button>
            <Button variant="ghost" size="default">
              Ghost
            </Button>
            <Button variant="outlined" size="primary">
              Primary size
            </Button>
            <Button variant="outlined" disabled>
              Disabled
            </Button>
          </Row>
        </Section>

        <Section heading="Icon Button">
          <Row gap={16}>
            <IconButton icon="Plus" label="Add" size={28} variant="ghost" onClick={() => {}} />
            <IconButton
              icon="MoreHorizontal"
              label="More"
              size={28}
              variant="ghost"
              onClick={() => {}}
            />
            <IconButton icon="Plus" label="Add" size={36} variant="filled" onClick={() => {}} />
            <IconButton icon="X" label="Close" size={36} variant="ghost" onClick={() => {}} />
          </Row>
        </Section>

        <Section heading="Icons">
          <Row gap={16}>
            <Icon name="Folder" size={16} />
            <Icon name="Terminal" size={16} />
            <Icon name="GitBranch" size={16} />
            <Icon name="Clock" size={16} />
            <Icon name="Database" size={16} />
            <Icon name="Plus" size={16} />
            <Icon name="X" size={16} />
            <Icon name="MoreHorizontal" size={16} />
          </Row>
        </Section>

        <Section heading="Icon Tiles">
          <Row gap={16}>
            <IconTile icon="Folder" size={28} tone="var(--accent)" />
            <IconTile icon="Terminal" size={40} tone="var(--status-working)" />
            <IconTile icon="Database" size={48} tone="var(--status-done)" />
          </Row>
        </Section>

        <Section heading="Status Dots">
          <Row gap={16}>
            <StatusDot status="working" size={8} />
            <StatusDot status="needs_attention" size={8} />
            <StatusDot status="done" size={8} />
            <StatusDot status="idle" size={8} />
            <StatusDot status="errored" size={8} />
            <StatusDot status="working" size={10} />
            <StatusDot status="needs_attention" size={10} />
            <StatusDot status="done" size={10} />
          </Row>
        </Section>

        <Section heading="Badges">
          <Row gap={16}>
            <Badge status="working" variant="chip" />
            <Badge status="needs_attention" variant="chip" />
            <Badge status="ready" variant="chip" />
            <Badge status="done" variant="chip" />
            <Badge status="idle" variant="chip" />
            <Badge status="working" variant="bare" />
            <Badge status="needs_attention" variant="bare" />
          </Row>
        </Section>

        <Section heading="Meta">
          <Meta gap={12}>
            <MetaItem icon="Clock">2 hours ago</MetaItem>
            <MetaItem icon="GitBranch">main</MetaItem>
            <MetaItem icon="Database">2.3k / 128k</MetaItem>
          </Meta>
        </Section>

        <Section heading="Input and Textarea">
          <Stack gap={16}>
            <Input placeholder="What's the mission?" />
            <Textarea placeholder="Write more details here…" />
            <SegmentedControl<SortOption>
              aria-label="Sort"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'recent', label: 'Recent' },
                { value: 'name', label: 'Name' },
                { value: 'status', label: 'Status' }
              ]}
            />
          </Stack>
        </Section>

        <Section heading="Pills">
          <Row gap={16}>
            <Pill tone="var(--accent)" active={false}>
              + Project
            </Pill>
            <Pill tone="var(--accent)" active={true}>
              + Project
            </Pill>
            <Pill tone="var(--status-working)" active={false}>
              Worktree
            </Pill>
            <Pill tone="var(--status-working)" active={true}>
              Worktree
            </Pill>
          </Row>
        </Section>

        <Section heading="Progress Bar">
          <Stack gap={16}>
            <ProgressBar value={0.25} tone="var(--status-done)" />
            <ProgressBar value={0.5} tone="var(--status-working)" />
            <ProgressBar value={0.75} tone="var(--status-attention)" />
          </Stack>
        </Section>

        <Section heading="Skeleton">
          <Stack gap={16}>
            <Skeleton shape="row" />
            <Skeleton shape="row" />
            <Skeleton shape="card" />
          </Stack>
        </Section>

        <Section heading="Empty State">
          <EmptyState
            icon="Boxes"
            title="No sessions"
            body="Create a new session to get started"
            action={<Button variant="filled">Create session</Button>}
          />
        </Section>

        <Section heading="Modal">
          <Button variant="filled" onClick={() => setShowModal(true)}>
            Open modal
          </Button>
          {showModal && (
            <Modal
              title="Context Window"
              icon="Database"
              width={560}
              onClose={() => setShowModal(false)}
            >
              <Stack gap={16}>
                <p className="gallery-type-body">This is modal content with a close button.</p>
                <ProgressBar value={0.556} tone="var(--status-done)" />
                <p className="gallery-type-caption">55.7k / 1.0M tokens used</p>
              </Stack>
            </Modal>
          )}
        </Section>

        <Section heading="Card grid (1.7 rhythm)">
          <div className="gallery-card-grid">
            {['alpha', 'beta', 'gamma'].map((name) => (
              <Card key={name} level="raised">
                <Stack gap={8}>
                  <div className="gallery-type-title">{name}-worktree</div>
                  <div className="gallery-type-body">Session card body copy, two lines max.</div>
                  <Row gap={8}>
                    <span className="gallery-badge">project</span>
                    <span className="gallery-badge">3 files</span>
                  </Row>
                </Stack>
              </Card>
            ))}
          </div>
        </Section>
      </Stack>
    </div>
  )
}

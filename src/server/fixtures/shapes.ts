import type { Catalog } from '../../studio/api'

/**
 * A model file's entries, as the studio merges them, of every shape a view's projection takes: a list of fragments
 * read over several hops, a view that holds itself, single and as a list, a path read in an order, aggregates, and a
 * relationship fragment that leads to a view. drivineModels.test declares the same classes with Drivine's decorators.
 */
const entry = { module: 'm' }
export const catalog: Catalog = {
  models: [],
  fragments: [
    {
      ...entry, id: 'Person', name: 'Person', labels: ['Person'], nodeId: 'uuid',
      properties: [
        { name: 'name', stored: 'name', type: 'string', nullable: false },
        { name: 'uuid', stored: 'person_id', type: 'string', nullable: false },
      ],
    },
    { ...entry, id: 'Team', name: 'Team', labels: ['Team'], properties: [{ name: 'name', stored: 'name', type: 'string', nullable: false }] },
  ],
  relationshipFragments: [
    {
      ...entry, id: 'Membership', name: 'Membership', target: { field: 'team', fragment: 'TeamView' },
      properties: [{ name: 'since', stored: 'since', type: 'string', nullable: false }],
    },
  ],
  views: [
    {
      ...entry, id: 'Manager', name: 'Manager', root: { field: 'person', fragment: 'Person' },
      relationships: [
        { field: 'manages', type: 'MANAGES', direction: 'OUTGOING', target: 'Person', many: true, required: false, maxDepth: 3 },
        { field: 'mentor', type: 'MENTORS', direction: 'INCOMING', target: 'Manager', many: false, required: false, maxDepth: 2 },
        { field: 'reports', type: 'REPORTS_TO', direction: 'INCOMING', target: 'Manager', many: true, required: true, maxDepth: 2 },
        {
          field: 'teams', target: 'Team', many: true, required: false,
          path: [{ type: 'MEMBER_OF', direction: 'OUTGOING' }, { type: 'PART_OF', direction: 'OUTGOING', label: 'Team', orderBy: 'name', ascending: false }],
        },
      ],
      aggregates: [
        { field: 'reportCount', function: 'COUNT', type: 'REPORTS_TO', direction: 'INCOMING' },
        { field: 'teamSize', function: 'SUM', type: 'MEMBER_OF', direction: 'OUTGOING', property: 'size' },
      ],
    },
    {
      ...entry, id: 'TeamView', name: 'TeamView', root: { field: 'team', fragment: 'Team' },
      relationships: [{ field: 'lead', type: 'LEADS', direction: 'INCOMING', target: 'Person', many: false, required: false }],
    },
    {
      ...entry, id: 'Member', name: 'Member', root: { field: 'person', fragment: 'Person' },
      relationships: [{ field: 'memberships', type: 'MEMBER_OF', direction: 'OUTGOING', target: 'Membership', many: true, required: false }],
    },
  ],
  problems: [],
}

// cytoscape-cola ships no types: it is a layout extension, registered with cytoscape.use and run by name.
declare module 'cytoscape-cola' {
  import type { Ext } from 'cytoscape'
  const cola: Ext
  export default cola
}

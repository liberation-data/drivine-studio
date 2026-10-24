import { forward } from '../backend'

export const dynamic = 'force-dynamic'

export const GET = () => forward('/catalog')

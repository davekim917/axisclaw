// The agent-runner is a separate Bun package that cannot import the host's catalog, so it gets a checked-in copy.
import fs from 'node:fs';

import { renderCardGuideModule } from '../src/channels/card-spec.js';

fs.writeFileSync('container/agent-runner/src/mcp-tools/card-guide.generated.ts', renderCardGuideModule());

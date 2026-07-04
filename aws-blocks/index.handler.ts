import { createLambdaHandler } from '@aws-blocks/blocks/lambda-handler';

// core's createLambdaHandler expects a factory `() => Promise<module>`, not the
// module object. (The scaffold template shipped the older module-arg form, which
// mismatches the installed @aws-blocks/core 0.1.x — preview version skew.)
export const handler = createLambdaHandler(() => import('./index.js'));

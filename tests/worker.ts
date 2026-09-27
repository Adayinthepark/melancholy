import { handleApi } from "../worker/api";
export { Conversation } from "../worker/conversation";
export { Connector } from "../worker/connector";
export default { fetch: handleApi };

const flowProcessor = require("./functions");
const { query } = require("../database/dbpromise");

async function processFlow({
  nodes,
  edges,
  uid,
  flowId,
  message,
  incomingText,
  user,
  sessionId,
  origin,
  chatId,
  element,
  webhookVariables = {},
}) {
  let result = { moveToNextNode: false };
  const flowSession = await flowProcessor.getFlowSession({
    flowId,
    message,
    uid,
    nodes,
    incomingText,
    edges,
    sessionId,
    origin,
    webhookVariables,
  });

  // returning if chat is disabled
  const checkIfDisabled = await flowProcessor.checkIfChatDisabled({
    flowSession,
  });

  if (checkIfDisabled && flowSession?.data?.disableChat?.timestamp) {
    return console.log("Chat found disabled", { checkIfDisabled });
  }
  // returning if chat is disabled end

  // checking if its assigend to ai
  const checkIfAssignedToAi = flowSession?.data?.assignedToAi;
  if (checkIfAssignedToAi) {
    console.log("Chat is assigned to AI, ai flow processing");
    await flowProcessor.processAiTransfer({
      chatId,
      message,
      node: flowSession?.data?.assignedToAi?.node,
      origin,
      sessionId,
      user,
      nodes,
      edges,
      flowSession,
      element,
      variablesObj,
      incomingText,
    });
    return;
  }

  console.log("RAN");
  if (!flowSession?.data?.node && origin !== "webhook_automation") {
    console.log(
      "Flow looks incomplete tryeing to delete session and try again "
    );
    if (origin === "qr") {
      await query(
        `DELETE FROM flow_session WHERE uid = ? AND origin = ? AND origin_id = ? AND flow_id = ? AND sender_mobile = ?`,
        [uid, origin, sessionId, flowId, message.senderMobile]
      );
    } else if (origin?.toLowerCase() === "webhook_automation") {
      await query(
        `DELETE FROM flow_session WHERE uid = ? AND origin = ? AND flow_id = ? AND sender_mobile = ?`,
        [uid, origin, flowId, message.senderMobile]
      );
    } else {
      await query(
        `DELETE FROM flow_session WHERE uid = ? AND origin = ? AND origin_id = ? AND flow_id = ? AND sender_mobile = ?`,
        [uid, "meta", "META", flowId, message.senderMobile]
      );
    }
    await processFlow({
      nodes,
      edges,
      uid,
      flowId: element.flow_id,
      message,
      incomingText,
      user,
      sessionId,
      origin,
      chatId,
      element,
    });
  }

  const { node: oldNode } = flowSession?.data;
  const variablesObj = flowSession?.data?.variables || {};

  // updating variabls
  let node;

  node = {
    ...oldNode,
    data: {
      ...oldNode?.data,
      content: flowProcessor.replaceVariables(
        oldNode?.data?.content,
        variablesObj
      ),
    },
  };

  switch (node.type) {
    case "SEND_MESSAGE":
      result = await flowProcessor.processSendMessage({
        chatId,
        message,
        node,
        origin,
        sessionId,
        user,
        nodes,
        edges,
        flowSession,
        element,
        variablesObj,
        incomingText,
      });
      break;

    case "CONDITION":
      result = await flowProcessor.processCondition({
        chatId,
        message,
        node,
        origin,
        sessionId,
        user,
        nodes,
        edges,
        flowSession,
        element,
        variablesObj,
        incomingText,
      });
      break;

    case "RESPONSE_SAVER":
      result = await flowProcessor.processResponseSaver({
        chatId,
        message,
        node,
        origin,
        sessionId,
        user,
        nodes,
        edges,
        flowSession,
        element,
        variablesObj,
        incomingText,
      });
      break;

    case "DISABLE_AUTOREPLY":
      result = await flowProcessor.processDisableAutoReply({
        chatId,
        message,
        node,
        origin,
        sessionId,
        user,
        nodes,
        edges,
        flowSession,
        element,
        variablesObj,
        incomingText,
      });
      break;

    case "MAKE_REQUEST":
      result = await flowProcessor.processMakeRequest({
        chatId,
        message,
        node,
        origin,
        sessionId,
        user,
        nodes,
        edges,
        flowSession,
        element,
        variablesObj,
        incomingText,
      });
      break;

    case "DELAY":
      result = await flowProcessor.processDelay({
        chatId,
        message,
        node,
        origin,
        sessionId,
        user,
        nodes,
        edges,
        flowSession,
        element,
        variablesObj,
        incomingText,
      });
      break;

    case "SPREADSHEET":
      result = await flowProcessor.processSpreadSheet({
        chatId,
        message,
        node,
        origin,
        sessionId,
        user,
        nodes,
        edges,
        flowSession,
        element,
        variablesObj,
        incomingText,
      });
      break;

    case "EMAIL":
      result = await flowProcessor.processSendEmail({
        chatId,
        message,
        node,
        origin,
        sessionId,
        user,
        nodes,
        edges,
        flowSession,
        element,
        variablesObj,
        incomingText,
      });
      break;

    case "AGENT_TRANSFER":
      result = await flowProcessor.processAgentTransfer({
        chatId,
        message,
        node,
        origin,
        sessionId,
        user,
        nodes,
        edges,
        flowSession,
        element,
        variablesObj,
        incomingText,
      });
      break;

    case "AI_TRANSFER":
      result = await flowProcessor.processAiTransfer({
        chatId,
        message,
        node,
        origin,
        sessionId,
        user,
        nodes,
        edges,
        flowSession,
        element,
        variablesObj,
        incomingText,
      });
      break;

    case "MYSQL_QUERY":
      result = await flowProcessor.processMysqlQuery({
        chatId,
        message,
        node,
        origin,
        sessionId,
        user,
        nodes,
        edges,
        flowSession,
        element,
        variablesObj,
        incomingText,
      });
      break;

    default:
      break;
  }

  console.log({ s: result?.moveToNextNode, type: node.type });

  if (result?.moveToNextNode) {
    setTimeout(async () => {
      await processFlow({
        nodes,
        edges,
        uid,
        flowId: element.flow_id,
        message,
        incomingText,
        user,
        sessionId,
        origin,
        chatId,
        element,
      });
    }, 1000);
  }
  try {
  } catch (err) {
    console.log(err);
  }
}

async function processAutomation({
  uid,
  message,
  user,
  sessionId,
  origin,
  chatId,
}) {
  const incomingText = flowProcessor.extractBodyText(message);
  const { senderMobile, senderName } = message;
  const userFlows = await flowProcessor.getActiveFlows({
    uid,
    origin,
    sessionId,
  });

  if (userFlows?.length < 1) {
    return console.log("User does not have any active automation flow");
  }

  if (!senderMobile) {
    return console.log("Invalid message found", message);
  }

  userFlows.forEach(async (element) => {
    try {
      // processing one flow
      const flowData = JSON.parse(element.data) || {};
      const nodes = flowData?.nodes || [];
      const edges = flowData?.edges || [];

      if (nodes?.length < 1 || edges?.length < 1) {
        return console.log(
          "Either nodes or edges length is zero of this automation flow with id:",
          element.flow_id
        );
      }

      await processFlow({
        nodes,
        edges,
        uid,
        flowId: element.flow_id,
        message,
        incomingText,
        user,
        sessionId,
        origin,
        chatId,
        element,
      });
    } catch (err) {
      console.log(err);
    }
  });
}

async function processWebhookAutomation({ webhook, data, type }) {
  try {
    const { uid } = webhook;
    const userFlows = await flowProcessor.getActiveFlows({
      uid: webhook?.uid,
      origin: "webhook_automation",
      webhook,
    });

    if (userFlows?.length < 1) {
      return console.log("User does not have any active automation flow");
    }

    const originData = userFlows?.origin ? JSON.parse(userFlows?.origin) : {};
    if (originData?.data?.webhook_id !== webhook?.webhook_id) {
      return console.log("This was not for this webhook");
    }

    userFlows.forEach(async (element) => {
      try {
        // processing one flow
        const flowData = JSON.parse(element.data) || {};
        const nodes = flowData?.nodes || [];
        const edges = flowData?.edges || [];

        const initialNode = nodes?.find((x) => x.id === "initialNode");
        if (!initialNode) {
          return console.log("Initial node not found in webhook hit");
        }

        const mobileNumberFromPath = flowProcessor.getNestedValue(
          initialNode?.data?.whPhonePath,
          data
        );

        if (!mobileNumberFromPath) {
          return console.log("No number was passed in the webhook");
        }

        const message = { senderMobile: mobileNumberFromPath };
        const { senderMobile } = message;

        if (!senderMobile || !uid) {
          return console.log("Invalid webhook found", { message, webhook });
        }

        if (nodes?.length < 1 || edges?.length < 1) {
          return console.log(
            "Either nodes or edges length is zero of this automation flow with id:",
            element.flow_id
          );
        }

        const [user] = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

        if (user) {
          await processFlow({
            nodes,
            edges,
            uid,
            flowId: element.flow_id,
            message,
            incomingText: "",
            user,
            sessionId: "",
            origin: "webhook_automation",
            chatId: "",
            element,
            webhookVariables: data || {},
          });
        }

        await query(
          `DELETE FROM flow_session WHERE uid = ? AND flow_id = ? AND sender_mobile = ?`,
          [uid, element.flow_id, message.senderMobile]
        );
      } catch (err) {
        console.log(err);
      }
    });
  } catch (err) {
    console.log(err);
  }
}

module.exports = { processAutomation, processWebhookAutomation };

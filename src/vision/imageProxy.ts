import * as vscode from "vscode";
import { DEFAULT_VISION_PROMPT } from "./types";

/**
 * Call a vision-capable model to describe an image.
 * @returns The description text.
 */
export async function callVisionModel(
    imageData: Uint8Array,
    mimeType: string,
    visionModelId: string,
    visionPrompt: string | undefined,
    token: vscode.CancellationToken
): Promise<string> {
    const models = await vscode.lm.selectChatModels({ id: visionModelId });
    if (!models || models.length === 0) {
        throw new Error(`Vision model "${visionModelId}" not found. Check the opencodegosniffer.visionProxyModel setting.`);
    }

    const visionModel = models[0];
    const dataPart = new vscode.LanguageModelDataPart(imageData, mimeType);
    const textPart = new vscode.LanguageModelTextPart(visionPrompt ?? DEFAULT_VISION_PROMPT);
    const msg = new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        [dataPart, textPart]
    );

    const options: vscode.LanguageModelChatRequestOptions & { reasoningEffort?: string } = {};
    // Enable thinking for better image descriptions when the model supports it
    const visionThinking = vscode.workspace.getConfiguration().get<boolean>("opencodegosniffer.visionProxyThinking", true);
    if (visionThinking) {
        options.reasoningEffort = "high";
    }
    const response = await visionModel.sendRequest([msg], options, token);
    let description = "";
    for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
            description += chunk.value;
        }
    }
    return description.trim();
}

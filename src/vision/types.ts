/**
 * Stored image data for describe_image tool processing.
 */
export interface StoredImage {
    /** Raw image bytes */
    data: Uint8Array;
    /** MIME type (e.g. "image/png") */
    mimeType: string;
}

/**
 * Information about an intercepted describe_image tool call.
 */
export interface InterceptedToolCall {
    /** Tool call ID from the API */
    id: string;
    /** Tool name (always "describe_image") */
    name: string;
    /** Parsed arguments (imageIndex, detailLevel) */
    args: { imageIndex: number; detailLevel?: "brief" | "normal" | "detailed" };
}

/**
 * The describe_image tool definition to inject into API requests.
 */
export const DESCRIBE_IMAGE_TOOL_DEF = {
    type: "function" as const,
    function: {
        name: "describe_image",
        description: "READ THIS: The user sent an image. I am a text-only model and CANNOT see images. I MUST call this tool to get a text description of the image. The description will tell me what the image shows so I can answer the user's question. I should ALWAYS call this tool when the user mentions an attached image or asks about image contents. Without calling this tool, I cannot know what the image contains.",
        parameters: {
            type: "object",
            properties: {
                imageIndex: {
                    type: "integer",
                    description: "The 0-based index of the image to describe",
                },
                detailLevel: {
                    type: "string",
                    enum: ["brief", "normal", "detailed"],
                    description: "How detailed the description should be",
                    default: "normal",
                },
            },
            required: ["imageIndex"],
        },
    },
};

export const DESCRIBE_IMAGE_TOOL_NAME = "describe_image";

export const DEFAULT_VISION_PROMPT =
    "Describe this image in detail. Include visible text, objects, UI elements, people, and relevant context. Do not invent details.";

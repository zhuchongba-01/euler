import { registerImagesApiProvider } from "../../images-api-registry.js";
import { generateImagesOpenRouter } from "./openrouter.js";

export function registerBuiltInImagesApiProviders(): void {
	registerImagesApiProvider({
		api: "openrouter-images",
		generateImages: generateImagesOpenRouter,
	});
}

registerBuiltInImagesApiProviders();

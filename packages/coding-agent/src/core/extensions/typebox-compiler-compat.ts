import { Code, Compile, Validator } from "typebox/compile";

export { Code, Compile, Validator };

// Legacy @sinclair/typebox/compiler compatibility for extensions.
export const TypeCompiler = {
	Compile,
};

// In TypeBox 0.x this was a named export. Map it to the v1 Validator class.
export const TypeCheck = Validator;

export default {
	Code,
	Compile,
	Validator,
	TypeCompiler,
	TypeCheck,
};

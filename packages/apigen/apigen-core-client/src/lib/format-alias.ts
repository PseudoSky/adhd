// format-alias.ts — DEBT-APIGEN-007 support.
//
// `extract.ts`'s param/return-type extraction resolves a TS type to its
// PRINTED text via ts-morph's `Type#getText()` (e.g. `p.getTypeAtLocation(...)
// .getText()`, `paramDecl.getType().getText()`, `sig.getReturnType().getText()`).
// That call eagerly resolves a type alias to its underlying primitive —
// `type DecimalValue = string` prints as `"string"`, not `"DecimalValue"` —
// which silently discards the alias's own name and therefore any JSDoc
// attached to the alias declaration itself (most importantly a `@format` tag
// used by logical-type dep-collection, see BACKLOG DEBT-APIGEN-007).
//
// This module is a NARROW, SEPARATE side-channel that recovers just that one
// piece of information — the `@format` JSDoc comment text on a plain,
// non-generic reference to a user-defined scalar type alias — from the
// syntactic `TypeNode` (the AST node as WRITTEN in source), which still
// carries the alias's identity even after `Type#getText()` has thrown it
// away. It does NOT change how `extract.ts` resolves param/return types for
// any other purpose (generics, structural types, etc. are all deliberately
// out of scope here — see the guards below).
import type {
  Identifier,
  TypeAliasDeclaration,
  TypeNode,
  TypeReferenceNode,
} from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

/**
 * Detects a `@format` JSDoc annotation on a plain, non-generic reference to a
 * user-defined scalar type alias (e.g. `/** @format decimal *\/ type X =
 * string;` referenced as a param/return type `X`), and returns the format
 * string if found.
 *
 * Deliberately narrow — returns `undefined` (never throws) for every case
 * outside this one:
 *   - `typeNode` absent, or not a `TypeReference` node at all (covers plain
 *     keyword types like `string`/`number`, array/tuple/union/etc. syntax).
 *   - A generic reference (`Array<X>`, `Foo<T>`, …) — out of scope per spec;
 *     the RESOLVED type at the call site must still flow through the
 *     existing `Type#getText()` path unchanged.
 *   - A qualified name (`Foo.Bar`) — only plain identifiers are considered.
 *   - The identifier has no resolvable symbol, or none of its declarations is
 *     a `TypeAliasDeclaration` (this alone already excludes interfaces,
 *     classes, enums, and generic type parameters — none of those are ever a
 *     `TypeAliasDeclaration`).
 *   - The alias's own underlying type is not a plain scalar (string / number
 *     / boolean) — guards against ever attaching `format` onto a structural
 *     / object alias.
 *   - No `@format` JSDoc tag is present on the alias declaration.
 *
 * Wrapped in a try/catch: this is an enhancement to extraction, never a
 * required path, and must never crash extraction on an unexpected ts-morph
 * API failure.
 *
 * @param typeNode - The syntactic type-node for a parameter or return type
 *   (e.g. `paramDecl?.getTypeNode()`, `sig.getDeclaration()?.getReturnTypeNode()`),
 *   as opposed to the RESOLVED `Type` that `Type#getText()` operates on.
 * @returns The trimmed `@format` JSDoc comment text, or `undefined`.
 */
export function detectFormatAnnotatedAlias(
  typeNode: TypeNode | undefined
): string | undefined {
  try {
    if (!typeNode) return undefined;
    if (typeNode.getKind() !== SyntaxKind.TypeReference) return undefined;

    const refNode = typeNode as TypeReferenceNode;
    // Generics are out of scope — the RESOLVED type at the call site (not
    // the literal syntactic type-argument text) is what must flow through
    // the existing `Type#getText()` path unchanged.
    if (refNode.getTypeArguments().length > 0) return undefined;

    const typeName = refNode.getTypeName();
    // Only a plain identifier reference (`X`), never a qualified name
    // (`Foo.Bar`) — qualified names are out of scope.
    if (typeName.getKind() !== SyntaxKind.Identifier) return undefined;

    const identifier = typeName as Identifier;
    const symbol = identifier.getSymbol();
    if (!symbol) return undefined;

    const aliasDeclNode = symbol
      .getDeclarations()
      .find((d) => d.getKindName() === 'TypeAliasDeclaration');
    if (!aliasDeclNode) return undefined;
    const aliasDecl = aliasDeclNode as TypeAliasDeclaration;

    const aliasType = aliasDecl.getType();
    const isScalarAlias =
      aliasType.isString() || aliasType.isNumber() || aliasType.isBoolean();
    if (!isScalarAlias) return undefined;

    const jsDocs = aliasDecl.getJsDocs();
    for (const doc of jsDocs) {
      for (const tag of doc.getTags()) {
        if (tag.getTagName() === 'format') {
          const comment = tag.getCommentText();
          if (comment !== undefined) return comment.trim();
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

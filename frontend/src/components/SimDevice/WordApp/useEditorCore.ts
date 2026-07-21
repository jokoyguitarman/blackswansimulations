import { useEffect, useRef, useState } from 'react';
import { Editor, Extension, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import { FontSize, TextStyle } from '@tiptap/extension-text-style';

const DocumentStyle = Extension.create({
  name: 'documentStyle',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          documentStyle: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-doc-style'),
            renderHTML: (attributes) =>
              attributes.documentStyle
                ? { 'data-doc-style': String(attributes.documentStyle) }
                : {},
          },
        },
      },
    ];
  },
});

export type DocumentStyleName = 'normal' | 'heading1' | 'heading2' | 'title';

export function useEditorCore({
  content,
  editable,
  onChange,
}: {
  content: string;
  editable: boolean;
  onChange: (html: string) => void;
}) {
  const onChangeRef = useRef(onChange);
  const [wordCount, setWordCount] = useState(0);
  const [, forceToolbarUpdate] = useState(0);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2] },
      }),
      Underline,
      TextStyle,
      FontSize,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: 'Start writing your response…' }),
      DocumentStyle,
    ],
    content: content || '<p></p>',
    editable,
    editorProps: {
      attributes: {
        class: 'docs-prosemirror',
        spellcheck: 'true',
      },
    },
    onCreate: ({ editor: nextEditor }) => setWordCount(countWords(nextEditor)),
    onUpdate: ({ editor: nextEditor }) => {
      setWordCount(countWords(nextEditor));
      forceToolbarUpdate((value) => value + 1);
      onChangeRef.current(nextEditor.getHTML());
    },
    onSelectionUpdate: () => forceToolbarUpdate((value) => value + 1),
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);

  return {
    editor,
    wordCount,
    applyStyle: (style: DocumentStyleName) => applyDocumentStyle(editor, style),
    activeStyle: getActiveDocumentStyle(editor),
  };
}

function countWords(editor: Editor): number {
  const text = editor.getText().trim();
  return text ? text.split(/\s+/).length : 0;
}

function applyDocumentStyle(editor: Editor | null, style: DocumentStyleName): void {
  if (!editor) return;
  if (style === 'normal') {
    editor
      .chain()
      .focus()
      .setParagraph()
      .updateAttributes('paragraph', { documentStyle: null })
      .run();
    return;
  }
  if (style === 'heading2') {
    editor
      .chain()
      .focus()
      .setHeading({ level: 2 })
      .updateAttributes('heading', { documentStyle: null })
      .run();
    return;
  }
  editor
    .chain()
    .focus()
    .setHeading({ level: 1 })
    .updateAttributes('heading', { documentStyle: style === 'title' ? 'title' : null })
    .run();
}

function getActiveDocumentStyle(editor: Editor | null): DocumentStyleName {
  if (!editor) return 'normal';
  if (editor.isActive('heading', { level: 1, documentStyle: 'title' })) return 'title';
  if (editor.isActive('heading', { level: 1 })) return 'heading1';
  if (editor.isActive('heading', { level: 2 })) return 'heading2';
  return 'normal';
}

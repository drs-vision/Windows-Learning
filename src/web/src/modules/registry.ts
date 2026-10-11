import type { LessonModule } from '../core/module';
import { typingQuest } from './typing-quest';
import { bibleTyping } from './bible-typing';
import { khanAcademy } from './khan-academy';

/** Every earning module, in the order the child sees them. Add yours here. */
export const MODULES: LessonModule[] = [typingQuest, bibleTyping, khanAcademy];

export const moduleById = (id: string) => MODULES.find((m) => m.id === id);

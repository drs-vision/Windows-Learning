import type { LessonModule } from '../core/module';
import { soundKeys } from './sound-keys';
import { typingQuest } from './typing-quest';
import { bibleTyping } from './bible-typing';
import { khanAcademy } from './khan-academy';

/** Every earning module, in the order the child sees them. Add yours here. */
export const MODULES: LessonModule[] = [soundKeys, typingQuest, bibleTyping, khanAcademy];

export const moduleById = (id: string) => MODULES.find((m) => m.id === id);

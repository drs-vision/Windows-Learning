import type { LessonModule } from '../core/module';
import { soundKeys } from './sound-keys';
import { typingQuest } from './typing-quest';
import { bibleTyping } from './bible-typing';
import { myPassages } from './my-passages';
import { books } from './books';
import { khanAcademy } from './khan-academy';
import { duolingo } from './duolingo';
import { rwt } from './rwt';
import { discGames } from './discgames';

/** Every earning module, in the order the child sees them. Add yours here. */
export const MODULES: LessonModule[] = [soundKeys, typingQuest, bibleTyping, myPassages, books, khanAcademy, duolingo, rwt, discGames];

export const moduleById = (id: string) => MODULES.find((m) => m.id === id);

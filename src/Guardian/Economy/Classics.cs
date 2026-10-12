namespace CoinQuest.Guardian.Economy;

/// <summary>
/// Starter list of beloved 2000s Flash classics, chosen for an 11–12-year-old. These are only SEARCH TERMS:
/// each is matched against the local Flashpoint catalog, and nothing reaches the child until a parent approves it.
/// Strategy: 1 = pure reflexes … 5 = pure planning/puzzle (more thinking = cheaper per play).
/// </summary>
public static class Classics
{
    public sealed record Pick(string Search, string Genre, int Strategy, string? Note = null);

    public static readonly Pick[] List =
    {
        // platformers & action
        new("Gravity Guy", "Runner", 1),
        new("Fancy Pants Adventures", "Platformer", 2),
        new("Fancy Pants Adventure: World 2", "Platformer", 2),
        new("Fancy Pants Adventure: World 3", "Platformer", 2),
        new("Super Mario 63", "Platformer", 2),
        new("Red Ball 4", "Platformer", 3),
        new("Run 2", "Runner", 2),
        new("Electric Man 2", "Fighting", 1, "Stick-figure fighting, no blood"),
        new("Stick War", "Strategy", 4, "Stick-figure armies"),
        new("Henry Stickmin: Breaking the Bank", "Choose your path", 4, "Pick a tool, see what happens — slapstick"),
        new("Henry Stickmin: Escaping the Prison", "Choose your path", 4),
        new("Henry Stickmin: Stealing the Diamond", "Choose your path", 4),
        new("Fireboy and Watergirl in The Forest Temple", "Puzzle platformer", 4),
        new("Fireboy and Watergirl 2: In the Light Temple", "Puzzle platformer", 4),
        new("Meat Boy", "Platformer", 1),
        new("N", "Platformer", 2),
        new("Shift", "Puzzle platformer", 4),
        new("This is the Only Level", "Puzzle platformer", 4),
        new("Achievement Unlocked", "Platformer", 3),
        new("Bubble Trouble", "Arcade", 1),
        new("Hedgehog Launch", "Launch", 2),
        // launch & upgrade
        new("Learn to Fly", "Launch & upgrade", 3),
        new("Learn to Fly 2", "Launch & upgrade", 3),
        new("Toss the Turtle", "Launch & upgrade", 3),
        new("Burrito Bison", "Launch & upgrade", 2),
        new("Raft Wars", "Artillery", 3),
        new("Raft Wars 2", "Artillery", 3),
        new("Tanks", "Artillery", 3, "Classic turn-based tanks"),
        new("Territory War", "Artillery", 3, "Stick-figure artillery"),
        new("Bowman", "Artillery", 3, "Archery duel — arrows, no gore"),
        new("Crush the Castle", "Physics", 4),
        new("Motherload", "Mining", 4),
        new("Duck Life", "Training", 3),
        new("Age of War", "Strategy", 4),
        // strategy & puzzle
        new("Bloons", "Puzzle", 4),
        new("Bloons Tower Defense 3", "Tower defense", 5),
        new("Bloons Tower Defense 4", "Tower defense", 5),
        new("Bloons Tower Defense 5", "Tower defense", 5),
        new("Desktop Tower Defense", "Tower defense", 5),
        new("GemCraft", "Tower defense", 5),
        new("Kingdom Rush", "Tower defense", 5),
        new("Portal: The Flash Version", "Puzzle", 5),
        new("Bloxorz", "Puzzle", 5),
        new("Sugar, Sugar", "Puzzle", 5),
        new("Doodle God", "Puzzle", 5),
        new("Cursor*10", "Puzzle", 5),
        new("Electric Box", "Puzzle", 5),
        new("Line Rider", "Creative", 5),
        new("Papa's Pizzeria", "Cooking", 4),
        new("Papa's Burgeria", "Cooking", 4),
        new("Monkey GO Happy", "Puzzle", 5),
        new("Snail Bob", "Puzzle", 5),
        new("The Impossible Quiz", "Trivia", 4, "Some cheeky jokes — preview first"),
        // racing & driving
        new("Cyclomaniacs", "Racing", 2), new("Cyclomaniacs 2", "Racing", 2), new("Uphill Rush", "Racing", 2), new("Uphill Rush 2", "Racing", 2),
        new("Coaster Racer", "Racing", 1), new("Coaster Racer 2", "Racing", 1), new("Heat Rush", "Racing", 1), new("Moto X3M", "Racing", 2),
        new("Drift Runners", "Racing", 1), new("Rally Point", "Racing", 2), new("Turbo Racing", "Racing", 1), new("Hill Climb Racing", "Racing", 2),
        new("Truck Loader", "Puzzle", 5), new("Monster Truck Destroyer", "Racing", 1), new("Mini Putt", "Sports", 3), new("Bike Mania", "Racing", 2),
        // sports
        new("Sports Heads Football", "Sports", 2), new("Big Head Football", "Sports", 2), new("Basketball Legends", "Sports", 2),
        new("Penalty Fever", "Sports", 2), new("Kick Ups", "Sports", 1), new("Bowling", "Sports", 2), new("Doyu Golf", "Sports", 3),
        // more strategy, building & thinking
        new("Stick War 2", "Strategy", 4), new("Kingdom Rush Frontiers", "Tower defense", 5), new("Cursed Treasure", "Tower defense", 5),
        new("Bloons Tower Defense 2", "Tower defense", 5), new("Bloons Player Pack", "Puzzle", 4), new("Bloons 2", "Puzzle", 4),
        new("Warlords: Call to Arms", "Strategy", 4), new("Epic War", "Strategy", 4), new("Clash of the Olympians", "Strategy", 4),
        new("Factory Balls", "Puzzle", 5), new("Red Remover", "Puzzle", 5), new("Cover Orange", "Puzzle", 5), new("Totem Destroyer", "Puzzle", 5),
        new("Wake Up the Box", "Puzzle", 5), new("Magic Pen", "Puzzle", 5), new("Coin Op Cubes", "Puzzle", 5), new("Swords and Sandals", "Strategy", 4, "Gladiator duels — cartoon"),
        new("Gold Miner", "Arcade", 3), new("Pandemic", "Strategy", 5, "Disease-spread strategy — preview"),
        // more platform, action, launch & upgrade
        new("Run 3", "Runner", 2), new("Super Smash Flash", "Fighting", 1), new("Sonic Rush", "Platformer", 1), new("Earn to Die", "Launch & upgrade", 3, "Driving through cartoon zombies — preview"),
        new("Gun Mayhem", "Fighting", 1, "Cartoon shooting — preview"), new("Strike Force Heroes", "Action", 2, "Cartoon shooter — preview"),
        new("Stickman Madness", "Physics", 3), new("Ragdoll Cannon", "Physics", 4),
        new("Johnny Upgrade", "Launch & upgrade", 3), new("Kitten Cannon", "Launch & upgrade", 2), new("Penguin Launch", "Launch & upgrade", 2),
        new("Flight", "Launch & upgrade", 3), new("Rocket Car", "Launch & upgrade", 3), new("Platform Racing 2", "Platformer", 2),
        new("Super Mario Flash", "Platformer", 2), new("Mario Combat", "Fighting", 1), new("Stick Run", "Runner", 1), new("Snowboard Stunts", "Sports", 2),
    };
}

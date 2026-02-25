package me.berrycraft.mirrorbot;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

import net.skinsrestorer.api.SkinsRestorer;
import net.skinsrestorer.api.SkinsRestorerProvider;
import net.skinsrestorer.api.exception.DataRequestException;
import net.skinsrestorer.api.exception.MineSkinException;
import net.skinsrestorer.api.property.InputDataResult;
import net.skinsrestorer.api.property.SkinIdentifier;
import net.skinsrestorer.api.property.SkinVariant;
import net.skinsrestorer.api.storage.PlayerStorage;
import net.skinsrestorer.api.storage.SkinStorage;

import java.io.File;
import java.io.IOException;
import java.util.*;

public class SkinManager {

    private final EpisodeManager plugin;
    private final SkinsRestorer skinsRestorer;
    private final File skinsDir;

    public SkinManager(EpisodeManager plugin) {
        this.plugin = plugin;

        if (Bukkit.getPluginManager().getPlugin("SkinsRestorer") != null) {
            skinsRestorer = SkinsRestorerProvider.get();
            plugin.getLogger().info("[SkinManager] SkinsRestorer detected, API attached.");
        } else {
            plugin.getLogger().warning("[SkinManager] SkinsRestorer not found. Skins will not be applied.");
            skinsRestorer = null;
        }

        this.skinsDir = resolveSkinsDirectory();
        if (skinsDir != null) {
            boolean created = skinsDir.mkdirs();
            plugin.getLogger().info("[SkinManager] Skins directory resolved to: " + skinsDir.getAbsolutePath() + " (created=" + created + ")");
        } else {
            plugin.getLogger().warning("[SkinManager] Failed to resolve skins directory; custom skins will be unavailable.");
        }
    }

    // ------------------------------------------------------------------------------------
    // Skin Loading
    // ------------------------------------------------------------------------------------

    public Map<String, File> loadSkins() {
        if (skinsDir == null || !skinsDir.exists()) {
            plugin.getLogger().warning("[SkinManager] Skins directory missing: " + skinsDir);
            return Collections.emptyMap();
        }

        Map<String, File> map = new TreeMap<>();
        File[] list = skinsDir.listFiles((dir, name) -> name.endsWith(".png"));
        if (list == null) {
            plugin.getLogger().warning("[SkinManager] listFiles returned null for: " + skinsDir.getAbsolutePath());
            return map;
        }

        for (File f : list) {
            map.put(normalizeName(f.getName()), f);
        }

        plugin.getLogger().info("[SkinManager] Loaded " + map.size() + " skin(s) from " + skinsDir.getAbsolutePath());
        return map;
    }

    public File resolveSkin(String key, Map<String, File> skins) {
        return skins.get(normalizeName(key));
    }

    private String normalizeName(String name) {
        name = name.toLowerCase(Locale.ROOT);
        if (name.endsWith(".png")) name = name.substring(0, name.length() - 4);

        int underscore = name.indexOf('_');
        if (underscore > 0) {
            String prefix = name.substring(0, underscore);
            if (prefix.chars().allMatch(Character::isDigit)) {
                name = name.substring(underscore + 1);
            }
        }
        return name;
    }

    // ------------------------------------------------------------------------------------
    // Skin Application
    // ------------------------------------------------------------------------------------

    public void applySharedSkin(Player controller, Player camera, File file) {
        if (skinsRestorer == null) {
            plugin.getLogger().warning("[SkinManager] SkinsRestorer unavailable; skipping skin apply for " + controller.getName() + " / " + camera.getName());
            return;
        }

        plugin.getLogger().info("[SkinManager] Applying shared skin " + file.getName() + " to " + controller.getName() + " and " + camera.getName());

        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
            try {
                SkinStorage storage = skinsRestorer.getSkinStorage();
                if (storage == null) {
                    plugin.getLogger().severe("[SkinManager] SkinStorage is null; cannot cache/apply skin.");
                    return;
                }

                String key = "file:" + file.getName().toLowerCase(Locale.ROOT);

                Optional<InputDataResult> cached = storage.findSkinData(key);
                SkinIdentifier id;

                if (cached.isPresent()) {
                    plugin.getLogger().info("[SkinManager] Using cached skin for key " + key);
                    id = cached.get().getIdentifier();
                } else {
                    plugin.getLogger().info("[SkinManager] Generating skin for key " + key + " from file " + file.getAbsolutePath());
                    var api = skinsRestorer.getMineSkinAPI();
                    var response = api.genSkin(file.toPath(), SkinVariant.CLASSIC);

                    storage.setCustomSkinData(key, response.getProperty());
                    id = storage.findSkinData(key).orElseThrow().getIdentifier();
                }

                PlayerStorage ps = skinsRestorer.getPlayerStorage();
                ps.setSkinIdOfPlayer(controller.getUniqueId(), id);
                ps.setSkinIdOfPlayer(camera.getUniqueId(), id);

                Bukkit.getScheduler().runTask(plugin, () -> {
                    try {
                        skinsRestorer.getSkinApplier(Player.class).applySkin(controller);
                        skinsRestorer.getSkinApplier(Player.class).applySkin(camera);
                    } catch (DataRequestException e) {
                        e.printStackTrace();
                    }
                });

            } catch (DataRequestException | MineSkinException | IOException ex) {
                plugin.getLogger().severe("[SkinManager] Failed to apply skin " + file.getName() + ": " + ex.getMessage());
                ex.printStackTrace();
            }
        });
    }

    public void resetAllSkins() {
        if (skinsRestorer == null) return;

        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
            for (Player p : Bukkit.getOnlinePlayers()) {
                try {
                    skinsRestorer.getPlayerStorage().removeSkinIdOfPlayer(p.getUniqueId());

                    Bukkit.getScheduler().runTask(plugin, () -> {
                        try {
                            skinsRestorer.getSkinApplier(Player.class).applySkin(p);
                        } catch (DataRequestException e) {
                            e.printStackTrace();
                        }
                    });

                } catch (Exception ignored) {
                }
            }
        });
    }

    private File resolveSkinsDirectory() {
        try {
            File pluginFolder = plugin.getDataFolder().getCanonicalFile();
            File pluginsDir = pluginFolder.getParentFile();

            File dataDir = pluginsDir.getParentFile();
            return (dataDir != null)
                    ? new File(dataDir, "skins")
                    : new File(pluginsDir, "skins");
        } catch (IOException e) {
            return null;
        }
    }
}

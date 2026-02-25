package me.berrycraft.mirrorbot;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.GameMode;
import org.bukkit.entity.Player;

import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;

import org.bukkit.event.player.PlayerAnimationEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerInteractAtEntityEvent;
import org.bukkit.event.player.PlayerToggleSneakEvent;
import org.bukkit.event.player.PlayerToggleSprintEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityTargetLivingEntityEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;

import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.attribute.Attribute;
import org.bukkit.attribute.AttributeInstance;
import org.bukkit.scheduler.BukkitTask;
import org.bukkit.util.Vector;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockDamageEvent;
import org.bukkit.event.block.BlockDamageAbortEvent;

import org.bukkit.Particle;
import org.bukkit.block.BlockFace;
import org.bukkit.util.RayTraceResult;
import org.bukkit.block.data.BlockData;
import org.bukkit.World;

import com.comphenix.protocol.ProtocolManager;
import com.comphenix.protocol.PacketType;
import com.comphenix.protocol.events.PacketAdapter;
import com.comphenix.protocol.events.PacketEvent;
import com.comphenix.protocol.events.PacketContainer;
import com.comphenix.protocol.wrappers.BlockPosition;

import java.lang.reflect.InvocationTargetException;
import java.util.*;

public class CameraManager implements Listener {

    private static final long MIN_SPRINT_MS = 200L;
    private static final double SNEAK_SCALE = 0.785; 
    private static final double NORMAL_SCALE = 1.0;

    private final EpisodeManager plugin;
    private final ProtocolManager protocol;
    private BukkitTask followTask;
    private long tickCounter = 0;

    private final Map<UUID, Long> sprintStartTime = new HashMap<>();

    // ================================
    // Block animation cache
    // ================================
    private final Map<BlockPosition, Integer> breakStageCache = new HashMap<>();
    private final Map<UUID, ActiveBreak> activeBreaks = new HashMap<>();

    public CameraManager(EpisodeManager plugin, ProtocolManager protocol) {
        this.plugin = plugin;
        this.protocol = protocol;
        registerBlockBreakForwarder();
    }

    // ============================================================================
    // Public Facing API
    // ============================================================================

    public void startFollowingTask() {
        stopFollowingTask();

        followTask = Bukkit.getScheduler().runTaskTimer(plugin, () -> {
            tickCounter++;

            // =======================================================
            // Replay cached block break animations every tick
            // (this prevents flickering)
            // =======================================================
            if (!breakStageCache.isEmpty()) {
                for (Map.Entry<BlockPosition, Integer> anim : breakStageCache.entrySet()) {
                    BlockPosition pos = anim.getKey();
                    int stage = anim.getValue();

                    for (Map.Entry<Player, Player> pair : plugin.getActivePairs().entrySet()) {
                        Player camera = pair.getValue();
                        forward(camera, pos, stage);
                    }
                }
            }

            // Emit block-break particles for active breaks
            if (!activeBreaks.isEmpty()) {
                for (Iterator<Map.Entry<UUID, ActiveBreak>> it = activeBreaks.entrySet().iterator(); it.hasNext(); ) {
                    Map.Entry<UUID, ActiveBreak> entry = it.next();
                    Player controller = Bukkit.getPlayer(entry.getKey());
                    ActiveBreak active = entry.getValue();

                    if (controller == null || !controller.isOnline()) {
                        it.remove();
                        continue;
                    }

                    // Expire if no updates recently (stopped digging)
                    if (tickCounter - active.lastUpdateTick > 3) {
                        it.remove();
                        continue;
                    }

                    Player camera = plugin.getActivePairs().get(controller);
                    if (camera == null || !camera.isOnline()) {
                        it.remove();
                        continue;
                    }

                    // If the block changed, drop the active state
                    if (!isSameBlockData(active)) {
                        it.remove();
                        continue;
                    }

                    Location center = new Location(active.world,
                            active.pos.getX() + 0.5,
                            active.pos.getY() + 0.5,
                            active.pos.getZ() + 0.5);
                    Vector offset = faceToOffset(active.face);
                    Location particleLoc = center.clone().add(offset);

                    // More frequent (every tick), fewer particles per burst
                    camera.spawnParticle(
                            Particle.BLOCK,
                            particleLoc,
                            2,           // low count
                            0.08, 0.08, 0.08,
                            0.03,
                            active.blockData
                    );
                }
            }

            // Camera following logic ------------------------------
            for (Map.Entry<Player, Player> entry : plugin.getActivePairs().entrySet()) {
                Player controller = entry.getKey();
                Player camera = entry.getValue();

                if (!controller.isOnline() || !camera.isOnline()) continue;

                mirrorInventory(controller, camera);
                mirrorStatus(controller, camera);

                Location cLoc = controller.getLocation();
                Location camLoc = camera.getLocation();

                boolean worldChanged = camLoc.getWorld() != cLoc.getWorld();
                boolean moved = worldChanged || camLoc.distanceSquared(cLoc) > 0.0025;

                boolean rotated =
                        Math.abs(camLoc.getYaw() - cLoc.getYaw()) > 1f ||
                                Math.abs(camLoc.getPitch() - cLoc.getPitch()) > 1f;

                boolean sprinting = controller.isSprinting();

                if (moved || rotated) {
                    camera.teleportAsync(cLoc.clone());
                }

                // Keep the spectator synced
                UUID spectatorId = plugin.getSpectatorForController(controller.getUniqueId());
                if (spectatorId != null) {
                    Player spectator = Bukkit.getPlayer(spectatorId);
                    if (spectator != null && spectator.isOnline()) {
                        if (spectator.getGameMode() != GameMode.SPECTATOR) {
                            spectator.setGameMode(GameMode.SPECTATOR);
                        }
                        spectator.teleportAsync(cLoc.clone());
                    }
                }
            }

        }, 0L, 1L);
    }

    public void stopFollowingTask() {
        if (followTask != null) {
            followTask.cancel();
            followTask = null;
        }
    }

    public void prepareCamera(Player cam) {
        disableCollisions(cam);
        applyCameraPhysics(cam);
    }

    public void restorePlayer(Player p) {
        enableCollisions(p);
        resetCameraPhysics(p);
    }

    // ============================================================================
    // Events
    // ============================================================================

    @EventHandler
    public void onSwing(PlayerAnimationEvent e) {
        Player controller = e.getPlayer();
        Player camera = plugin.getActivePairs().get(controller);
        if (camera != null) camera.swingMainHand();
    }

    @EventHandler
    public void onAttack(EntityDamageByEntityEvent e) {
        if (!(e.getDamager() instanceof Player controller)) return;
        Player camera = plugin.getActivePairs().get(controller);
        if (camera != null) camera.swingMainHand();
    }

    @EventHandler
    public void onRightClick(PlayerInteractEvent e) {
        Player controller = e.getPlayer();
        Player camera = plugin.getActivePairs().get(controller);
        if (camera == null) return;

        switch (e.getAction()) {
            case RIGHT_CLICK_AIR:
            case RIGHT_CLICK_BLOCK:
                camera.swingMainHand();
                break;
        }
    }

    @EventHandler
    public void onRightClickEntity(PlayerInteractAtEntityEvent e) {
        Player controller = e.getPlayer();
        Player camera = plugin.getActivePairs().get(controller);
        if (camera != null) camera.swingMainHand();
    }

    @EventHandler
    public void onSneak(PlayerToggleSneakEvent e) {
        Player controller = e.getPlayer();
        Player camera = plugin.getActivePairs().get(controller);
        if (camera == null) return;

        AttributeInstance scaleAttr = camera.getAttribute(Attribute.GENERIC_SCALE);
        if (scaleAttr == null) return; // safety fallback

        if (e.isSneaking()) {
            // shrink to 7/8 height
            scaleAttr.setBaseValue(SNEAK_SCALE);
        } else {
            // restore normal full height
            scaleAttr.setBaseValue(NORMAL_SCALE);
        }
    }

    // @EventHandler
    // public void onSprint(PlayerToggleSprintEvent e) {
    //     Player controller = e.getPlayer();

    //     // Only care about controllers that have cameras
    //     if (!plugin.getActivePairs().containsKey(controller)) return;

    //     UUID id = controller.getUniqueId();

    //     if (e.isSprinting()) {
    //         sprintStartTime.put(id, System.currentTimeMillis());
    //     } else {
    //         Long start = sprintStartTime.get(id);
    //         if (start != null && System.currentTimeMillis() - start < MIN_SPRINT_MS) {
    //             e.setCancelled(true);
    //         } else {
    //             sprintStartTime.remove(id);
    //         }
    //     }
    // }

    @EventHandler(ignoreCancelled = true)
    public void onTargetCamera(EntityTargetLivingEntityEvent e) {
        if (!(e.getTarget() instanceof Player p)) return;
        if (!plugin.isCamera(p)) return;

        e.setCancelled(true);
        e.setTarget(null);
    }

    @EventHandler(ignoreCancelled = true)
    public void onDamageCamera(EntityDamageEvent e) {
        if (!(e.getEntity() instanceof Player p)) return;
        if (!plugin.isCamera(p)) return;

        e.setCancelled(true);
        e.setDamage(0);
        p.setFireTicks(0);
    }

    @EventHandler(ignoreCancelled = true)
    public void onPickup(EntityPickupItemEvent e) {
        if (!(e.getEntity() instanceof Player p)) return;
        if (!plugin.isCamera(p)) return;

        e.setCancelled(true);
    }

    @EventHandler(ignoreCancelled = true)
    public void onBlockBreak(BlockBreakEvent e) {
        Player controller = e.getPlayer();
        Player camera = plugin.getActivePairs().get(controller);
        if (camera == null) return;

        org.bukkit.block.Block block = e.getBlock();

        camera.spawnParticle(
                Particle.BLOCK,
                block.getX() + 0.5,
                block.getY() + 0.5,
                block.getZ() + 0.5,
                100,
                0.15, 0.15, 0.15,
                0.025,
                block.getBlockData()
        );
    }

    @EventHandler(ignoreCancelled = true)
    public void onBlockDamageAbort(org.bukkit.event.block.BlockDamageAbortEvent e) {
        Player controller = e.getPlayer();

        // Only controllers, not cameras
        if (!plugin.getActivePairs().containsKey(controller)) return;

        BlockPosition pos = new BlockPosition(
                e.getBlock().getX(),
                e.getBlock().getY(),
                e.getBlock().getZ()
        );

        // Clear cached crack stage
        breakStageCache.remove(pos);
        activeBreaks.remove(controller.getUniqueId());

        // Forward "clear animation" to camera
        Player camera = plugin.getActivePairs().get(controller);
        if (camera != null) {
            forward(camera, pos, -1); // stage -1 resets the animation
        }
    }

    // ============================================================================
    // Private Helpers
    // ============================================================================

    private void mirrorInventory(Player controller, Player camera) {
        PlayerInventory ci = controller.getInventory();
        PlayerInventory ki = camera.getInventory();

        if (!Arrays.equals(ci.getStorageContents(), ki.getStorageContents())) {
            ki.setStorageContents(clone(ci.getStorageContents()));
        }
        if (!Arrays.equals(ci.getArmorContents(), ki.getArmorContents())) {
            ki.setArmorContents(clone(ci.getArmorContents()));
        }
        if (!Objects.equals(ci.getItemInOffHand(), ki.getItemInOffHand())) {
            ki.setItemInOffHand(clone(ci.getItemInOffHand()));
        }
        if (ki.getHeldItemSlot() != ci.getHeldItemSlot()) {
            ki.setHeldItemSlot(ci.getHeldItemSlot());
        }
    }

    private void mirrorStatus(Player ctrl, Player cam) {
        AttributeInstance maxHpAttr = cam.getAttribute(Attribute.GENERIC_MAX_HEALTH);
        double maxHp = maxHpAttr != null ? maxHpAttr.getValue() : 20;

        double target = Math.max(0, Math.min(ctrl.getHealth(), maxHp));
        if (Math.abs(cam.getHealth() - target) > 0.01) cam.setHealth(target);

        cam.setFoodLevel(ctrl.getFoodLevel());
        cam.setSaturation(ctrl.getSaturation());
        cam.setExhaustion(ctrl.getExhaustion());
        cam.setRemainingAir(ctrl.getRemainingAir());
        cam.setMaximumAir(ctrl.getMaximumAir());
    }

    private boolean isCamera(Player p) {
        return plugin.isCamera(p);
    }

    private void applyCameraPhysics(Player cam) {
        cam.setGravity(false);
        cam.setVelocity(new Vector(0, 0, 0));
        cam.setAllowFlight(true);
        cam.setFlying(true);
    }

    private void resetCameraPhysics(Player p) {
        p.setGravity(true);
        if (p.getGameMode() != GameMode.CREATIVE && p.getGameMode() != GameMode.SPECTATOR) {
            p.setAllowFlight(false);
            if (p.isFlying()) p.setFlying(false);
        }
    }

    private void disableCollisions(Player p) {
        setCollidable(p, false);
    }

    private void enableCollisions(Player p) {
        setCollidable(p, true);
    }

    private void setCollidable(Player p, boolean b) {
        try {
            p.setCollidable(b);
        } catch (Exception ignored) {}

        try {
            Object spigot = p.spigot();
            var m = spigot.getClass().getMethod("setCollidesWithEntities", boolean.class);
            m.invoke(spigot, b);
        } catch (NoSuchMethodException | IllegalAccessException | InvocationTargetException ignored) {}
    }

    private Vector faceToOffset(Enum<?> face) {
        switch (face.name()) {
            case "DOWN":  return new Vector(0, -0.5, 0);
            case "UP":    return new Vector(0, 0.5, 0);
            case "NORTH": return new Vector(0, 0, -0.5);
            case "SOUTH": return new Vector(0, 0, 0.5);
            case "WEST":  return new Vector(-0.5, 0, 0);
            case "EAST":  return new Vector(0.5, 0, 0);
            default:      return new Vector(0, 0, 0);
        }
    }

    private BlockFace getHitFace(Player player, BlockPosition pos) {
        Location eye = player.getEyeLocation();

        RayTraceResult result = player.rayTraceBlocks(5.0);

        if (result == null) return BlockFace.SELF;
        if (result.getHitBlock() == null) return BlockFace.SELF;

        org.bukkit.block.Block hitBlock = result.getHitBlock();

        // Make sure this raycast actually hit the same block as the break animation
        if (hitBlock.getX() == pos.getX() &&
            hitBlock.getY() == pos.getY() &&
            hitBlock.getZ() == pos.getZ()) {

            return result.getHitBlockFace();
        }

        return BlockFace.SELF; // fallback
    }

    // ============================================================================
    // Breaking Animation
    // ============================================================================
    private void registerBlockBreakForwarder() {

        // Listen for crack animation (0-9)
        protocol.addPacketListener(
                new com.comphenix.protocol.events.PacketAdapter(plugin, PacketType.Play.Server.BLOCK_BREAK_ANIMATION) {
                    @Override
                    public void onPacketSending(com.comphenix.protocol.events.PacketEvent event) {

                        EpisodeManager handler = (EpisodeManager) plugin;

                        PacketContainer packet = event.getPacket();
                        if (packet.getMeta("MirrorBotRelay").isPresent()) return;

                        int breakerId = packet.getIntegers().read(0);
                        int stage = packet.getIntegers().read(1);
                        BlockPosition pos = packet.getBlockPositionModifier().read(0);

                        // Clamp stage: never allow stage 9 (clear)
                        int storedStage = Math.min(stage, 8);
                        breakStageCache.put(pos, storedStage);

                        for (Map.Entry<Player, Player> entry : handler.getActivePairs().entrySet()) {
                            Player controller = entry.getKey();
                            Player camera = entry.getValue();

                            if (controller == null || camera == null) continue;

                            boolean isBreaker = breakerId == controller.getEntityId();
                            boolean forCtrl = event.getPlayer().equals(controller);

                            if (isBreaker || forCtrl) {
                                updateActiveBreak(controller, pos, storedStage);
                                forward(camera, pos, storedStage);
                            }
                        }
                    }
                }
        );

        // BLOCK_CHANGE → block actually changed → clear crack
        protocol.addPacketListener(
                new com.comphenix.protocol.events.PacketAdapter(plugin, PacketType.Play.Server.BLOCK_CHANGE) {
                    @Override
                public void onPacketSending(com.comphenix.protocol.events.PacketEvent event) {
                    BlockPosition pos = event.getPacket().getBlockPositionModifier().read(0);
                    breakStageCache.remove(pos);
                    clearActiveBreak(pos);
                }
            }
        );

    }

    private void forward(Player viewer, BlockPosition pos, int stage) {
        try {
            PacketContainer relay = protocol.createPacket(PacketType.Play.Server.BLOCK_BREAK_ANIMATION);
            relay.getBlockPositionModifier().write(0, pos);
            relay.getIntegers().write(0, viewer.getEntityId());
            relay.getIntegers().write(1, stage);
            relay.setMeta("MirrorBotRelay", true);

            protocol.sendServerPacket(viewer, relay);
        } catch (Exception ignored) {}
    }

    // ============================================================================
    // ItemStack Cloning
    // ============================================================================
    private ItemStack[] clone(ItemStack[] items) {
        if (items == null) return new ItemStack[0];
        ItemStack[] arr = new ItemStack[items.length];
        for (int i = 0; i < items.length; i++) arr[i] = clone(items[i]);
        return arr;
    }

    private ItemStack clone(ItemStack i) {
        return i == null ? null : i.clone();
    }

    // ============================================================================
    // Active break tracking
    // ============================================================================
    private void updateActiveBreak(Player controller, BlockPosition pos, int stage) {
        if (stage < 0 || stage >= 9) {
            activeBreaks.remove(controller.getUniqueId());
            return;
        }

        BlockFace face = getHitFace(controller, pos);
        World world = controller.getWorld();
        org.bukkit.block.Block block = world.getBlockAt(pos.getX(), pos.getY(), pos.getZ());
        BlockData data = block.getBlockData().clone();

        ActiveBreak active = new ActiveBreak(world, pos, face, data, tickCounter);
        activeBreaks.put(controller.getUniqueId(), active);
    }

    private void clearActiveBreak(BlockPosition pos) {
        activeBreaks.entrySet().removeIf(entry -> {
            BlockPosition p = entry.getValue().pos;
            return p.getX() == pos.getX() && p.getY() == pos.getY() && p.getZ() == pos.getZ();
        });
    }

    private boolean isSameBlockData(ActiveBreak active) {
        org.bukkit.block.Block live = active.world.getBlockAt(active.pos.getX(), active.pos.getY(), active.pos.getZ());
        return live.getType() == active.blockData.getMaterial() &&
               live.getBlockData().getAsString().equals(active.blockData.getAsString());
    }

    private static final class ActiveBreak {
        final World world;
        final BlockPosition pos;
        final BlockFace face;
        final BlockData blockData;
        final long lastUpdateTick;

        ActiveBreak(World world, BlockPosition pos, BlockFace face, BlockData blockData, long lastUpdateTick) {
            this.world = world;
            this.pos = pos;
            this.face = face;
            this.blockData = blockData;
            this.lastUpdateTick = lastUpdateTick;
        }
    }
}

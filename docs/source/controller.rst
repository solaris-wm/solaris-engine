Controller
================

The Controller component of ``SolarisEngine`` is JavaScript program built on top of
`Mineflayer <https://github.com/PrismarineJS/mineflayer>`_. It connects via TCP to the
controller bots of other players and through communication and the high level API of
Mineflayer makes the bots engage in collaborative gameplay. The controller is built around episode types. 
An episode type represents a specific multiplayer scenario the bots engage in. To ensure diversity and
good coverage of various game mechanics, 
it has a collection of :ref:`14 training episode types <training-episode-types>`. 
For evaluation it has a collection of separate :ref:`7 eval episode types <eval-episode-types>`,
featuring core multiplayer mechanics. 
All episodes types currently support only two players.


Design
------

Through out the life of the controller program, it establishes a connection with the
server and creates a ``mineflayer.Bot()`` instance just once at startup. After that,
it reuses the same ``bot`` instance to collect as many episodes as specified in the
``--episodes_num`` CLI arg. The entry point to the controller is the
:js:func:`episodes-loop.getOnSpawnFn` function which Mineflayer calls when the bot has
connected to the server. The function runs in a loop sampling random episodes,
executing them, and sending actions to the separate ``action_recorder`` process to be
saved as json files on disk.


Controllers of player share the same random generator, ``sharedBotRng`` that they use
to sample the same episode type randomly on every loop iteration. To ensure that the
episode starts in a clean state and in a new terrain, the controller teleports the
players to a new random location and resets their inventories before starting to record
the episode.

The episode loop has a error handling mechanism where it catches any error the might
occur during the episode execution and notifies other players about it. They
collectively abort the current episode and progress to the next one.

To ensure the data collection doesn't get interrupted with the player dying, the
controller gives the players infinite resistance, water breathing, and no fall damage
via RCON at the program startup.

All episode types inherit :js:class:`episode-handlers.base-episode.BaseEpisode` that provides them with the basic episode lifecycle: setupEpisode, entryPoint, tearDownEpisode, and stop-phase coordination.
An episode consists of multiple phases. At the beginning and end of a phase all players
wait for each other an exchange arbitrary values needed for the phase progression. This
phasing mechanism, combined with the ``sharedBotRng`` ensure the bots progress through
the episode in synchronization. All episodes types are an instance of a concrete game
scenario that runs from start to finish. They are build on top of primitives that
provide reusable API like :ref:`building <api-building>`, :ref:`digging <api-digging>`, :ref:`fighting <api-fighting>`, or :ref:`moving <api-movement>`. 

.. toctree::
   :maxdepth: 1

   controller_episodes
   api

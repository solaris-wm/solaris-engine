Getting Started
===============

Requirements
----------

The engine expects a GPU Linux machine with Docker and Docker Compose installed (Ubuntu `instructions <https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository>`_). Additionally,
to give GPU access to dockers, you need to install the `NVIDIA Container Toolkit <https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html>`_.

The system is tested to work on Ubuntu 22.04 LTS and 24.04 LTS and with CUDA versions 12.4 and 13.0. You need an NVENC-enabled GPU, e.g.
professional-line GPUs like the RTX 8000, RTX A6000, RTX 6000 Ada, and RTX PRO 6000 Blackwell, or gaming GPUs like the RTX 2080 Ti, RTX 3090, RTX 4090, and RTX 5090.
Notably, ML-centric GPUs like NVIDIA A100/H100/B100/B200 will not work because they do not have NVENC support. Theoretically, all NVIDIA GPUs can be supported if NVENC
is diabled, but we did not try this. Nevertheless, we recommend gaming-centric GPUs as they offer much better value for rendering compared to ML-centric ones.

While we managed to run an earlier version on Windows, compatibility
is not gauranteed. Other platforms are not tested.

Performance Notes
----------

Based on our testing, one RTX 4090 24GB comfortably runs 4 docker instances (for a total of 8 players). We observe a VRAM usage of around 1.2 GB per docker instance. Any GPU ≥ RTX 2080 Ti is also expected to work. You need at least 4 (modern) CPU cores per instance. If you observe smooth graphics but slow loading or animation desyncs, it likely reflects a CPU bottleneck.

Known Issue(s)
----------
At the moment, only physical GPU 0 can be used due to an `NVIDIA driver bug <https://forums.developer.nvidia.com/t/nvenc-and-nvdec-work-on-only-one-gpu-with-multi-gpu-setups-with-nvidia-container-toolkit-in-driver-565/347361>`_ that affects NVIDIA Container Toolkit and NVENC. Since NVIDA limits the number of parallel NVENC encoding streams per GPU to 8, this also means there can be at most 8 concurrent graphics-enabled players.

We hope to include a multi-GPU fix after NVIDIA addresses the driver bug, which will also unlock > 8 players. While NVENC encoding is helpful for reducing CPU load, we might test CPU encoding options to enable > 8 players.



How to Run
----------

#. Create the conda env:

   .. code-block:: bash

      conda env create -f env.yaml

#. Collect training data:

   .. code-block:: bash

      ./run.sh

#. Collect eval data:

   .. code-block:: bash

      ./run_evals.sh

The :ref:`run.sh <run-sh>` and :ref:`run_evals.sh <run-evals-sh>` will generate and store training and eval datasets in ``./output/datasets/``.

See :doc:`system_overview` for the explanation of what happens under the hood.

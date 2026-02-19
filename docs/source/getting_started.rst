Getting Started
===============

Requirements
----------

The engine expects a GPU Linux machine with Docker and Docker Compose installed.

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